#!/usr/bin/env node
/**
 * mmBacktest.js
 * Main backtest runner — replays the MM strategy against historical markets
 * from PolyBackTest.com API.
 *
 * Usage:
 *   node src/backtest/mmBacktest.js --duration 5m [--sell-price 0.60] [--cut-loss 60]
 *     [--entry-window 45] [--liquidity-check true] [--max-imbalance 0.20]
 *     [--recovery false] [--trade-size 5] [--limit 100]
 *
 * Momentum strategy (when one side fills + momentum one-sided: cancel other, add or trail):
 *   --strategy momentum [--momentum-mode trail|add] [--momentum-lookback 3] [--add-target 0.70]
 */

import { listMarkets, getSnapshots } from './polybacktestClient.js';
import { simulateMarket } from './mmBacktestEngine.js';
import { simulateMarketMomentum } from './mmMomentumEngine.js';
import { computeSummary, writeBacktestExcel } from './backtestSession.js';
import { fetchKlines, fetchLongShortRatio, sleep } from './binanceClient.js';
import { computeRsi, computeMacd, computeSessionVwap, computeAtr, computeBBWidth } from './indicators.js';
import logger from '../utils/logger.js';
import { mkdirSync, appendFileSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';

// ── Backtest log file ────────────────────────────────────────────────────────
const __dirname = dirname(fileURLToPath(import.meta.url));
const LOG_DIR = join(__dirname, '../../data/logs');

function initBacktestLog() {
    mkdirSync(LOG_DIR, { recursive: true });
    const ts = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
    const logPath = join(LOG_DIR, `backtest-${ts}.log`);

    // Monkey-patch logger to also write to file
    const origWrite = process.stdout.write.bind(process.stdout);
    process.stdout.write = (chunk, ...args) => {
        origWrite(chunk, ...args);
        try {
            // Strip ANSI codes for the log file
            const plain = String(chunk).replace(/\x1b\[[0-9;]*m/g, '');
            appendFileSync(logPath, plain);
        } catch { /* ignore */ }
        return true;
    };

    return logPath;
}

// ── Parse CLI args ───────────────────────────────────────────────────────────

function parseArgs() {
    const args = process.argv.slice(2);
    const params = {
        duration: '5m',
        sellPrice: 0.60,
        cutLossSeconds: 60,
        entryWindow: 45,
        liquidityCheck: true,
        maxImbalance: 0.20,
        recovery: false,
        tradeSize: 5,
        limit: 0, // 0 = all markets
        rsiMin: 0,    // skip if RSI < rsiMin (0 = disabled)
        rsiMax: 100,  // skip if RSI > rsiMax (100 = disabled)
        maxMacdHist: 0, // skip if |macdHist| > maxMacdHist (0 = disabled)
        maxAtr: 0,     // skip if ATR > maxAtr (0 = disabled)
        maxBbw: 0,     // skip if Bollinger Band Width > maxBbw (0 = disabled)
        maxDelta3m: 0, // skip if |btcPriceDelta3m| > maxDelta3m (0 = disabled)
        strategy: 'mm',         // 'mm' | 'momentum'
        momentumMode: 'trail',  // 'add' | 'trail' (when strategy=momentum)
        momentumLookback: 3,    // snapshots to confirm momentum trend
        addTarget: 0.70,       // exit target for add mode (when strategy=momentum, momentumMode=add)
    };

    for (let i = 0; i < args.length; i++) {
        const arg = args[i];
        const next = args[i + 1];
        switch (arg) {
            case '--duration':       params.duration = next; i++; break;
            case '--sell-price':     params.sellPrice = parseFloat(next); i++; break;
            case '--cut-loss':       params.cutLossSeconds = parseInt(next, 10); i++; break;
            case '--entry-window':   params.entryWindow = parseInt(next, 10); i++; break;
            case '--liquidity-check': params.liquidityCheck = next !== 'false'; i++; break;
            case '--max-imbalance':  params.maxImbalance = parseFloat(next); i++; break;
            case '--recovery':       params.recovery = next === 'true'; i++; break;
            case '--trade-size':     params.tradeSize = parseFloat(next); i++; break;
            case '--limit':          params.limit = parseInt(next, 10); i++; break;
            case '--rsi-min':        params.rsiMin = parseFloat(next); i++; break;
            case '--rsi-max':        params.rsiMax = parseFloat(next); i++; break;
            case '--max-macd-hist':  params.maxMacdHist = parseFloat(next); i++; break;
            case '--max-atr':        params.maxAtr = parseFloat(next); i++; break;
            case '--max-bbw':        params.maxBbw = parseFloat(next); i++; break;
            case '--max-delta-3m':   params.maxDelta3m = parseFloat(next); i++; break;
            case '--strategy':       params.strategy = next; i++; break;
            case '--momentum-mode':  params.momentumMode = next; i++; break;
            case '--momentum-lookback': params.momentumLookback = parseInt(next, 10); i++; break;
            case '--add-target':     params.addTarget = parseFloat(next); i++; break;
        }
    }

    return params;
}

// ── Formatting helpers ───────────────────────────────────────────────────────

function formatElapsed(ms) {
    if (ms < 1000) return `${ms}ms`;
    return `${(ms / 1000).toFixed(1)}s`;
}

function formatPnl(pnl) {
    const sign = pnl >= 0 ? '+' : '';
    return `${sign}$${pnl.toFixed(2)}`;
}

const EXIT_LABELS = {
    both_filled: 'BOTH FILL',
    merge: 'MERGE',
    cut_loss: 'CUT LOSS',
    cut_loss_recovery: 'CUT+RECOV',
    momentum_add: 'MOM+ADD',
    momentum_trail: 'MOM+TRAIL',
};

const SKIP_LABELS = {
    no_snapshots: 'no snapshots',
    no_entry_snapshot: 'no entry snap',
};

// ── Binance indicator helpers ────────────────────────────────────────────────

function toMs(value) {
    if (typeof value === 'number') {
        // If it looks like seconds (< 2e10), convert to ms
        return value < 2e10 ? value * 1000 : value;
    }
    return new Date(value).getTime();
}

/**
 * Fetch BTC klines and long/short ratio, compute indicators at market start_time.
 * Returns an object with indicator values (all numbers or null).
 */
async function fetchIndicators(startTime) {
    const startMs = toMs(startTime);
    const klineStart = startMs - 60 * 60 * 1000; // 60 minutes before

    const indicators = {
        rsi14: null,
        macdLine: null,
        macdSignal: null,
        macdHist: null,
        vwap: null,
        btcPriceDelta1m: null,
        btcPriceDelta3m: null,
        longShortRatio: null,
        atr14: null,
        bbw20: null,
    };

    try {
        const klines = await fetchKlines('BTCUSDT', '1m', 60, klineStart);
        await sleep(200);

        if (klines && klines.length > 0) {
            const closes = klines.map((k) => k.close);

            // RSI(14)
            indicators.rsi14 = computeRsi(closes, 14);

            // MACD(12, 26, 9)
            const macd = computeMacd(closes, 12, 26, 9);
            if (macd) {
                indicators.macdLine = macd.macd;
                indicators.macdSignal = macd.signal;
                indicators.macdHist = macd.hist;
            }

            // Session VWAP
            indicators.vwap = computeSessionVwap(klines);

            // ATR(14) — volatility
            indicators.atr14 = computeAtr(klines, 14);

            // Bollinger Band Width (20, 2) — volatility
            indicators.bbw20 = computeBBWidth(closes, 20);

            // BTC price deltas (1m, 3m)
            if (closes.length >= 2) {
                indicators.btcPriceDelta1m = closes[closes.length - 1] - closes[closes.length - 2];
            }
            if (closes.length >= 4) {
                indicators.btcPriceDelta3m = closes[closes.length - 1] - closes[closes.length - 4];
            }
        }
    } catch (err) {
        logger.warn(`Binance kline fetch failed: ${err.message}`);
    }

    try {
        // Snap to nearest 5m boundary for L/S ratio, pass endTime to get historical data
        const lsStart = Math.floor(startMs / (5 * 60 * 1000)) * (5 * 60 * 1000);
        const lsEnd = lsStart + 5 * 60 * 1000;
        indicators.longShortRatio = await fetchLongShortRatio('BTCUSDT', '5m', 1, lsStart, lsEnd);
        await sleep(200);
    } catch (err) {
        logger.warn(`Binance L/S ratio fetch failed: ${err.message}`);
    }

    return indicators;
}

function formatIndicator(val, decimals = 2) {
    if (val == null) return 'N/A';
    return typeof val === 'number' ? val.toFixed(decimals) : String(val);
}

// ── Main ─────────────────────────────────────────────────────────────────────

async function main() {
    const logPath = initBacktestLog();
    const params = parseArgs();

    logger.info(`MM Backtest starting — duration: ${params.duration}`);
    logger.info(`Log file: ${logPath}`);
    logger.info(`Params: strategy=${params.strategy} sell=${params.sellPrice} cutLoss=${params.cutLossSeconds}s entry=${params.entryWindow}s imbalance=${params.maxImbalance} recovery=${params.recovery} limit=${params.limit || 'all'} rsi=${params.rsiMin}-${params.rsiMax} maxMacdHist=${params.maxMacdHist || 'off'}`);
    if (params.strategy === 'momentum') {
        logger.info(`Momentum: mode=${params.momentumMode} lookback=${params.momentumLookback} addTarget=${params.addTarget}`);
    }

    // 1. Fetch all resolved markets
    logger.info('Fetching markets from PolyBackTest API...');
    let markets;
    try {
        markets = await listMarkets(params.duration);
    } catch (err) {
        logger.error(`Failed to fetch markets: ${err.message}`);
        process.exit(1);
    }

    if (markets.length === 0) {
        logger.warn('No markets found. Check your API key and duration parameter.');
        process.exit(0);
    }

    // Sort by start_time ascending (oldest first)
    markets.sort((a, b) => {
        const tA = typeof a.start_time === 'number' ? a.start_time : new Date(a.start_time).getTime();
        const tB = typeof b.start_time === 'number' ? b.start_time : new Date(b.start_time).getTime();
        return tA - tB;
    });

    // Apply --limit (take the N most recent markets)
    if (params.limit > 0 && markets.length > params.limit) {
        markets = markets.slice(-params.limit);
        logger.info(`Limited to last ${params.limit} markets (by start_time)`);
    }

    logger.info(`Found ${markets.length} markets — processing in chronological order...`);
    console.log('');

    // 2. Iterate each market, fetch snapshots, run simulation
    const results = [];
    let processed = 0;
    let runningPnl = 0;

    for (const market of markets) {
        processed++;
        const slug = market.slug || market.market_id || '';
        const counter = `[${processed}/${markets.length}]`;
        const t0 = Date.now();

        try {
            // Fetch indicators and snapshots upfront so we can show maxY/N for ALL markets
            const [indicators, snapshots] = await Promise.all([
                fetchIndicators(market.start_time),
                getSnapshots(market.market_id),
            ]);

            // Compute max YES/NO prices from snapshots for display on all logs
            let maxPriceUp = null, maxPriceDown = null;
            if (snapshots && snapshots.length > 0) {
                for (const s of snapshots) {
                    const pu = parseFloat(s.price_up);
                    const pd = parseFloat(s.price_down);
                    if (!Number.isNaN(pu)) maxPriceUp = maxPriceUp == null ? pu : Math.max(maxPriceUp, pu);
                    if (!Number.isNaN(pd)) maxPriceDown = maxPriceDown == null ? pd : Math.max(maxPriceDown, pd);
                }
            }
            const maxPriceStr = (maxPriceUp != null && maxPriceDown != null)
                ? ` maxY/N: ${maxPriceUp.toFixed(2)}/${maxPriceDown.toFixed(2)}`
                : '';

            // Build indicator summary string for logging
            const indStr = `RSI=${formatIndicator(indicators.rsi14)} MACD=${formatIndicator(indicators.macdHist)} ATR=${formatIndicator(indicators.atr14, 0)} BBW=${formatIndicator(indicators.bbw20 != null ? indicators.bbw20 * 100 : null, 3)}% d3m=${formatIndicator(indicators.btcPriceDelta3m, 0)}`;

            // RSI filter — skip extreme momentum
            if (indicators.rsi14 != null && (indicators.rsi14 < params.rsiMin || indicators.rsi14 > params.rsiMax)) {
                const elapsed = formatElapsed(Date.now() - t0);
                const reason = `rsi_${indicators.rsi14.toFixed(1)}`;
                logger.warn(`${counter} ${slug} — SKIP (${reason}) | ${indStr}${maxPriceStr} [${elapsed}]`);
                results.push({
                    marketId: market.market_id, slug: market.slug || '',
                    startTime: market.start_time, endTime: market.end_time,
                    status: 'skipped', skipReason: reason, pnl: 0, yesPnl: 0, noPnl: 0,
                    maxPriceUp, maxPriceDown, ...indicators,
                });
                continue;
            }

            // MACD histogram filter — skip strong trends
            if (params.maxMacdHist > 0 && indicators.macdHist != null && Math.abs(indicators.macdHist) > params.maxMacdHist) {
                const elapsed = formatElapsed(Date.now() - t0);
                const reason = `macd_${indicators.macdHist.toFixed(1)}`;
                logger.warn(`${counter} ${slug} — SKIP (${reason}) | ${indStr}${maxPriceStr} [${elapsed}]`);
                results.push({
                    marketId: market.market_id, slug: market.slug || '',
                    startTime: market.start_time, endTime: market.end_time,
                    status: 'skipped', skipReason: reason, pnl: 0, yesPnl: 0, noPnl: 0,
                    maxPriceUp, maxPriceDown, ...indicators,
                });
                continue;
            }

            // ATR filter — skip high volatility
            if (params.maxAtr > 0 && indicators.atr14 != null && indicators.atr14 > params.maxAtr) {
                const elapsed = formatElapsed(Date.now() - t0);
                const reason = `atr_${indicators.atr14.toFixed(1)}`;
                logger.warn(`${counter} ${slug} — SKIP (${reason}) | ${indStr}${maxPriceStr} [${elapsed}]`);
                results.push({
                    marketId: market.market_id, slug: market.slug || '',
                    startTime: market.start_time, endTime: market.end_time,
                    status: 'skipped', skipReason: reason, pnl: 0, yesPnl: 0, noPnl: 0,
                    maxPriceUp, maxPriceDown, ...indicators,
                });
                continue;
            }

            // Bollinger Band Width filter — skip wide bands (high volatility)
            if (params.maxBbw > 0 && indicators.bbw20 != null && indicators.bbw20 > params.maxBbw) {
                const elapsed = formatElapsed(Date.now() - t0);
                const reason = `bbw_${(indicators.bbw20 * 100).toFixed(3)}%`;
                logger.warn(`${counter} ${slug} — SKIP (${reason}) | ${indStr}${maxPriceStr} [${elapsed}]`);
                results.push({
                    marketId: market.market_id, slug: market.slug || '',
                    startTime: market.start_time, endTime: market.end_time,
                    status: 'skipped', skipReason: reason, pnl: 0, yesPnl: 0, noPnl: 0,
                    maxPriceUp, maxPriceDown, ...indicators,
                });
                continue;
            }

            // BTC 3m price delta filter — skip if BTC moved too much recently
            if (params.maxDelta3m > 0 && indicators.btcPriceDelta3m != null && Math.abs(indicators.btcPriceDelta3m) > params.maxDelta3m) {
                const elapsed = formatElapsed(Date.now() - t0);
                const reason = `delta3m_${indicators.btcPriceDelta3m.toFixed(0)}`;
                logger.warn(`${counter} ${slug} — SKIP (${reason}) | ${indStr}${maxPriceStr} [${elapsed}]`);
                results.push({
                    marketId: market.market_id, slug: market.slug || '',
                    startTime: market.start_time, endTime: market.end_time,
                    status: 'skipped', skipReason: reason, pnl: 0, yesPnl: 0, noPnl: 0,
                    maxPriceUp, maxPriceDown, ...indicators,
                });
                continue;
            }

            const simFn = params.strategy === 'momentum' ? simulateMarketMomentum : simulateMarket;
            const result = simFn(market, snapshots, params);

            // Attach indicators to result (simulateMarket already has maxPriceUp/maxPriceDown from snapshots)
            Object.assign(result, indicators);
            results.push(result);

            const elapsed = formatElapsed(Date.now() - t0);

            if (result.status === 'skipped') {
                const reason = SKIP_LABELS[result.skipReason] || result.skipReason;
                logger.warn(`${counter} ${slug} — SKIP (${reason}) | ${indStr}${maxPriceStr} [${elapsed}]`);
            } else {
                runningPnl += result.pnl;
                const exitLabel = EXIT_LABELS[result.exitType] || result.exitType;
                const pnlStr = formatPnl(result.pnl);
                const totalStr = formatPnl(runningPnl);
                const logFn = result.pnl > 0 ? logger.money : result.pnl < 0 ? logger.warn : logger.info;
                logFn(`${counter} ${slug} — ${exitLabel} ${pnlStr} | ${indStr}${maxPriceStr} | cumulative: ${totalStr} [${elapsed}]`);
            }
        } catch (err) {
            const elapsed = formatElapsed(Date.now() - t0);
            logger.error(`${counter} ${slug} — ERROR: ${err.message} [${elapsed}]`);
            results.push({
                marketId: market.market_id,
                slug: market.slug || '',
                startTime: market.start_time,
                endTime: market.end_time,
                status: 'skipped',
                skipReason: `error: ${err.message}`,
                pnl: 0,
                yesPnl: 0,
                noPnl: 0,
            });
        }
    }

    console.log('');

    // 3. Compute summary and write Excel
    const summary = computeSummary(results, params);

    // Print summary to console
    logger.info('═══════════════════════════════════════════');
    logger.info('         MM BACKTEST RESULTS');
    logger.info('═══════════════════════════════════════════');
    logger.info(`Duration:          ${params.duration}`);
    logger.info(`Total Markets:     ${summary.totalMarkets}`);
    logger.info(`Entered:           ${summary.enteredMarkets}`);
    logger.info(`Skipped:           ${summary.skippedMarkets}`);
    logger.info('───────────────────────────────────────────');
    logger.info(`Both Filled:       ${summary.bothFilledCount} (${summary.bothFillRate}%)`);
    logger.info(`Merged:            ${summary.mergedCount}`);
    logger.info(`Cut Loss:          ${summary.cutLossCount}`);
    if (params.strategy === 'momentum') {
        logger.info(`Momentum Add:       ${summary.momentumAddCount ?? 0}`);
        logger.info(`Momentum Trail:     ${summary.momentumTrailCount ?? 0}`);
    }
    logger.info('───────────────────────────────────────────');
    logger.money(`Total P&L:         $${summary.totalPnl.toFixed(2)}`);
    logger.info(`Avg P&L/Market:    $${summary.avgPnl.toFixed(4)}`);
    logger.info(`Max Win:           $${summary.maxWin.toFixed(2)}`);
    logger.info(`Max Loss:          $${summary.maxLoss.toFixed(2)}`);
    logger.info(`Max Drawdown:      $${summary.maxDrawdown.toFixed(2)}`);
    logger.info('───────────────────────────────────────────');
    logger.info(`Wins:              ${summary.winCount}`);
    logger.info(`Losses:            ${summary.lossCount}`);
    logger.info(`Breakeven:         ${summary.breakevenCount}`);
    logger.info(`Win Rate:          ${summary.winRate}%`);
    logger.info(`Avg Spread@Entry:  ${summary.avgSpreadAtEntry}`);
    logger.info('═══════════════════════════════════════════');

    // Write Excel
    try {
        const filepath = writeBacktestExcel(results, summary, params.duration);
        logger.success(`Excel written: ${filepath}`);
    } catch (err) {
        logger.error(`Failed to write Excel: ${err.message}`);
    }
}

main().catch((err) => {
    logger.error(`Backtest failed: ${err.message}`);
    console.error(err);
    process.exit(1);
});
