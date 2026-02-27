#!/usr/bin/env node
/**
 * mmMomentumBacktest.js
 * Backtest runner for the standalone MM-Momentum strategy.
 * Replays the directional momentum strategy against historical markets.
 *
 * Usage:
 *   node src/backtest/mmMomentumBacktest.js --duration 5m
 *     [--entry-threshold 0.60] [--exit-target 0.98] [--entry-window 45]
 *     [--cut-loss 30] [--trade-size 5] [--trail true] [--trail-drop-pct 0.05]
 *     [--min-depth 0] [--limit 100]
 *     [--rsi-min 0] [--rsi-max 100] [--max-atr 0] [--max-bbw 0]
 */

import { listMarkets, getSnapshots } from './polybacktestClient.js';
import { simulateMomentumStandalone } from './mmMomentumStandaloneEngine.js';
import { fetchKlines, fetchLongShortRatio, sleep } from './binanceClient.js';
import { computeRsi, computeMacd, computeSessionVwap, computeAtr, computeBBWidth } from './indicators.js';
import logger from '../utils/logger.js';
import { mkdirSync, appendFileSync } from 'fs';
import { dirname, join } from 'path';
import { fileURLToPath } from 'url';
import * as XLSX from 'xlsx';

const __dirname = dirname(fileURLToPath(import.meta.url));
const LOG_DIR = join(__dirname, '../../data/logs');
const DATA_DIR = join(__dirname, '../../data');

function initBacktestLog() {
    mkdirSync(LOG_DIR, { recursive: true });
    const ts = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
    const logPath = join(LOG_DIR, `mom-backtest-${ts}.log`);

    const origWrite = process.stdout.write.bind(process.stdout);
    process.stdout.write = (chunk, ...args) => {
        origWrite(chunk, ...args);
        try {
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
        entryThreshold: 0.60,
        exitTarget: 0.98,
        entryWindow: 45,
        cutLossSeconds: 30,
        tradeSize: 5,
        trailEnabled: true,
        trailDropPct: 0.05,
        minDepth: 0,
        limit: 0,
        rsiMin: 0,
        rsiMax: 100,
        maxMacdHist: 0,
        maxAtr: 0,
        maxBbw: 0,
        maxDelta3m: 0,
    };

    for (let i = 0; i < args.length; i++) {
        const arg = args[i];
        const next = args[i + 1];
        switch (arg) {
            case '--duration':          params.duration = next; i++; break;
            case '--entry-threshold':   params.entryThreshold = parseFloat(next); i++; break;
            case '--exit-target':       params.exitTarget = parseFloat(next); i++; break;
            case '--entry-window':      params.entryWindow = parseInt(next, 10); i++; break;
            case '--cut-loss':          params.cutLossSeconds = parseInt(next, 10); i++; break;
            case '--trade-size':        params.tradeSize = parseFloat(next); i++; break;
            case '--trail':             params.trailEnabled = next !== 'false'; i++; break;
            case '--trail-drop-pct':    params.trailDropPct = parseFloat(next); i++; break;
            case '--min-depth':         params.minDepth = parseFloat(next); i++; break;
            case '--limit':             params.limit = parseInt(next, 10); i++; break;
            case '--rsi-min':           params.rsiMin = parseFloat(next); i++; break;
            case '--rsi-max':           params.rsiMax = parseFloat(next); i++; break;
            case '--max-macd-hist':     params.maxMacdHist = parseFloat(next); i++; break;
            case '--max-atr':           params.maxAtr = parseFloat(next); i++; break;
            case '--max-bbw':           params.maxBbw = parseFloat(next); i++; break;
            case '--max-delta-3m':      params.maxDelta3m = parseFloat(next); i++; break;
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
    target_hit: 'TARGET',
    trail_stop: 'TRAIL',
    cut_loss: 'CUT LOSS',
    expiry: 'EXPIRY',
};

function formatIndicator(val, decimals = 2) {
    if (val == null) return 'N/A';
    return typeof val === 'number' ? val.toFixed(decimals) : String(val);
}

// ── Binance indicators ───────────────────────────────────────────────────────

function toMs(value) {
    if (typeof value === 'number') return value < 2e10 ? value * 1000 : value;
    return new Date(value).getTime();
}

async function fetchIndicators(startTime) {
    const startMs = toMs(startTime);
    const klineStart = startMs - 60 * 60 * 1000;

    const indicators = {
        rsi14: null, macdLine: null, macdSignal: null, macdHist: null,
        vwap: null, btcPriceDelta1m: null, btcPriceDelta3m: null,
        longShortRatio: null, atr14: null, bbw20: null,
    };

    try {
        const klines = await fetchKlines('BTCUSDT', '1m', 60, klineStart);
        await sleep(200);

        if (klines && klines.length > 0) {
            const closes = klines.map((k) => k.close);
            indicators.rsi14 = computeRsi(closes, 14);
            const macd = computeMacd(closes, 12, 26, 9);
            if (macd) {
                indicators.macdLine = macd.macd;
                indicators.macdSignal = macd.signal;
                indicators.macdHist = macd.hist;
            }
            indicators.vwap = computeSessionVwap(klines);
            indicators.atr14 = computeAtr(klines, 14);
            indicators.bbw20 = computeBBWidth(closes, 20);
            if (closes.length >= 2) indicators.btcPriceDelta1m = closes[closes.length - 1] - closes[closes.length - 2];
            if (closes.length >= 4) indicators.btcPriceDelta3m = closes[closes.length - 1] - closes[closes.length - 4];
        }
    } catch (err) {
        logger.warn(`Binance kline fetch failed: ${err.message}`);
    }

    try {
        const lsStart = Math.floor(startMs / (5 * 60 * 1000)) * (5 * 60 * 1000);
        const lsEnd = lsStart + 5 * 60 * 1000;
        indicators.longShortRatio = await fetchLongShortRatio('BTCUSDT', '5m', 1, lsStart, lsEnd);
        await sleep(200);
    } catch (err) {
        logger.warn(`Binance L/S ratio fetch failed: ${err.message}`);
    }

    return indicators;
}

// ── Summary computation ──────────────────────────────────────────────────────

function computeSummary(results, params) {
    const entered = results.filter((r) => r.status === 'closed');
    const skipped = results.filter((r) => r.status === 'skipped');
    const targetHit = entered.filter((r) => r.exitType === 'target_hit');
    const trailStop = entered.filter((r) => r.exitType === 'trail_stop');
    const cutLoss = entered.filter((r) => r.exitType === 'cut_loss');
    const expiry = entered.filter((r) => r.exitType === 'expiry');

    const totalPnl = entered.reduce((sum, r) => sum + r.pnl, 0);
    const wins = entered.filter((r) => r.pnl > 0);
    const losses = entered.filter((r) => r.pnl < 0);
    const breakeven = entered.filter((r) => r.pnl === 0);

    const pnls = entered.map((r) => r.pnl).sort((a, b) => a - b);
    const maxWin = pnls.length > 0 ? pnls[pnls.length - 1] : 0;
    const maxLoss = pnls.length > 0 ? pnls[0] : 0;
    const avgPnl = entered.length > 0 ? totalPnl / entered.length : 0;

    let peak = 0, maxDrawdown = 0, cumPnl = 0;
    for (const r of entered) {
        cumPnl += r.pnl;
        if (cumPnl > peak) peak = cumPnl;
        const dd = peak - cumPnl;
        if (dd > maxDrawdown) maxDrawdown = dd;
    }

    // Side distribution
    const yesEntries = entered.filter((r) => r.entrySide === 'yes').length;
    const noEntries = entered.filter((r) => r.entrySide === 'no').length;

    // Avg entry time from start
    const entryTimes = entered.map((r) => r.entrySecondsFromStart).filter((v) => v != null);
    const avgEntryTime = entryTimes.length > 0 ? entryTimes.reduce((a, b) => a + b, 0) / entryTimes.length : 0;

    return {
        totalMarkets: results.length,
        enteredMarkets: entered.length,
        skippedMarkets: skipped.length,
        targetHitCount: targetHit.length,
        trailStopCount: trailStop.length,
        cutLossCount: cutLoss.length,
        expiryCount: expiry.length,
        targetHitRate: entered.length > 0 ? (targetHit.length / entered.length * 100).toFixed(1) : '0.0',
        totalPnl,
        avgPnl,
        maxWin,
        maxLoss,
        maxDrawdown,
        winCount: wins.length,
        lossCount: losses.length,
        breakevenCount: breakeven.length,
        winRate: entered.length > 0 ? (wins.length / entered.length * 100).toFixed(1) : '0.0',
        yesEntries,
        noEntries,
        avgEntryTime: avgEntryTime.toFixed(1),
        params,
    };
}

// ── Excel output ─────────────────────────────────────────────────────────────

function writeBacktestExcel(results, summary, duration) {
    const wb = XLSX.utils.book_new();

    const summaryData = [
        ['MM-Momentum Backtest Summary', ''],
        ['', ''],
        ['Duration', duration],
        ['Total Markets', summary.totalMarkets],
        ['Entered Markets', summary.enteredMarkets],
        ['Skipped Markets', summary.skippedMarkets],
        ['', ''],
        ['── Results ──', ''],
        ['Target Hit', summary.targetHitCount],
        ['Trail Stop', summary.trailStopCount],
        ['Cut Loss', summary.cutLossCount],
        ['Expiry', summary.expiryCount],
        ['Target Hit Rate (%)', `${summary.targetHitRate}%`],
        ['', ''],
        ['── Side Distribution ──', ''],
        ['YES Entries', summary.yesEntries],
        ['NO Entries', summary.noEntries],
        ['Avg Entry Time (s)', summary.avgEntryTime],
        ['', ''],
        ['── P&L ──', ''],
        ['Total P&L (USDC)', summary.totalPnl.toFixed(2)],
        ['Avg P&L per Market', summary.avgPnl.toFixed(4)],
        ['Max Win', summary.maxWin.toFixed(2)],
        ['Max Loss', summary.maxLoss.toFixed(2)],
        ['Max Drawdown', summary.maxDrawdown.toFixed(2)],
        ['', ''],
        ['── Win/Loss ──', ''],
        ['Wins', summary.winCount],
        ['Losses', summary.lossCount],
        ['Breakeven', summary.breakevenCount],
        ['Win Rate (%)', `${summary.winRate}%`],
        ['', ''],
        ['── Strategy Params ──', ''],
        ['Entry Threshold', summary.params.entryThreshold],
        ['Exit Target', summary.params.exitTarget],
        ['Entry Window (s)', summary.params.entryWindow],
        ['Cut Loss (s)', summary.params.cutLossSeconds],
        ['Trade Size', summary.params.tradeSize],
        ['Trail Enabled', summary.params.trailEnabled],
        ['Trail Drop %', summary.params.trailDropPct],
        ['Min Depth', summary.params.minDepth],
    ];
    const wsSummary = XLSX.utils.aoa_to_sheet(summaryData);
    XLSX.utils.book_append_sheet(wb, wsSummary, 'Summary');

    // Positions sheet
    const entered = results.filter((r) => r.status === 'closed');
    if (entered.length > 0) {
        const posKeys = [
            'marketId', 'slug', 'startTime', 'endTime', 'winner',
            'btcPriceStart', 'btcPriceEnd', 'finalVolume', 'finalLiquidity',
            'entrySide', 'entryPrice', 'entryTime', 'entrySecondsFromStart',
            'entryPriceUp', 'entryPriceDown',
            'maxPriceUp', 'maxPriceDown', 'maxPriceAfterEntry',
            'shares', 'exitPrice', 'exitTime', 'exitType', 'pnl',
            'depthAtEntry',
            'rsi14', 'macdLine', 'macdSignal', 'macdHist',
            'vwap', 'btcPriceDelta1m', 'btcPriceDelta3m', 'longShortRatio',
            'atr14', 'bbw20',
        ];
        const posRows = [
            posKeys,
            ...entered.map((r) => posKeys.map((k) => r[k] != null ? r[k] : '')),
        ];
        const wsPositions = XLSX.utils.aoa_to_sheet(posRows);
        XLSX.utils.book_append_sheet(wb, wsPositions, 'Positions');
    }

    // Skipped sheet
    const skipped = results.filter((r) => r.status === 'skipped');
    if (skipped.length > 0) {
        const skipKeys = [
            'marketId', 'slug', 'startTime', 'endTime', 'skipReason',
            'maxPriceUp', 'maxPriceDown', 'finalVolume', 'finalLiquidity',
        ];
        const skipRows = [
            skipKeys,
            ...skipped.map((r) => skipKeys.map((k) => r[k] != null ? r[k] : '')),
        ];
        const wsSkipped = XLSX.utils.aoa_to_sheet(skipRows);
        XLSX.utils.book_append_sheet(wb, wsSkipped, 'Skipped Markets');
    }

    try { mkdirSync(DATA_DIR, { recursive: true }); } catch { /* ignore */ }

    const ts = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
    const filename = `mom-backtest-btc-${duration}-${ts}.xlsx`;
    const filepath = join(DATA_DIR, filename);
    XLSX.writeFile(wb, filepath);
    return filepath;
}

// ── Main ─────────────────────────────────────────────────────────────────────

async function main() {
    const logPath = initBacktestLog();
    const params = parseArgs();

    logger.info(`MM-Momentum Backtest starting — duration: ${params.duration}`);
    logger.info(`Log file: ${logPath}`);
    logger.info(`Params: threshold=${params.entryThreshold} target=${params.exitTarget} window=${params.entryWindow}s cutLoss=${params.cutLossSeconds}s size=${params.tradeSize} trail=${params.trailEnabled} dropPct=${(params.trailDropPct * 100).toFixed(0)}% minDepth=${params.minDepth}`);

    logger.info('Fetching markets from PolyBackTest API...');
    let markets;
    try {
        markets = await listMarkets(params.duration);
    } catch (err) {
        logger.error(`Failed to fetch markets: ${err.message}`);
        process.exit(1);
    }

    if (markets.length === 0) {
        logger.warn('No markets found.');
        process.exit(0);
    }

    markets.sort((a, b) => {
        const tA = typeof a.start_time === 'number' ? a.start_time : new Date(a.start_time).getTime();
        const tB = typeof b.start_time === 'number' ? b.start_time : new Date(b.start_time).getTime();
        return tA - tB;
    });

    if (params.limit > 0 && markets.length > params.limit) {
        markets = markets.slice(-params.limit);
        logger.info(`Limited to last ${params.limit} markets`);
    }

    logger.info(`Found ${markets.length} markets — processing...`);
    console.log('');

    const results = [];
    let processed = 0;
    let runningPnl = 0;

    for (const market of markets) {
        processed++;
        const slug = market.slug || market.market_id || '';
        const counter = `[${processed}/${markets.length}]`;
        const t0 = Date.now();

        try {
            const [indicators, snapshots] = await Promise.all([
                fetchIndicators(market.start_time),
                getSnapshots(market.market_id),
            ]);

            // Max prices for display
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

            const indStr = `RSI=${formatIndicator(indicators.rsi14)} MACD=${formatIndicator(indicators.macdHist)} ATR=${formatIndicator(indicators.atr14, 0)} BBW=${formatIndicator(indicators.bbw20 != null ? indicators.bbw20 * 100 : null, 3)}%`;

            // RSI filter
            if (indicators.rsi14 != null && (indicators.rsi14 < params.rsiMin || indicators.rsi14 > params.rsiMax)) {
                const elapsed = formatElapsed(Date.now() - t0);
                const reason = `rsi_${indicators.rsi14.toFixed(1)}`;
                logger.warn(`${counter} ${slug} — SKIP (${reason}) | ${indStr}${maxPriceStr} [${elapsed}]`);
                results.push({ marketId: market.market_id, slug: market.slug || '', startTime: market.start_time, endTime: market.end_time, status: 'skipped', skipReason: reason, pnl: 0, maxPriceUp, maxPriceDown, ...indicators });
                continue;
            }

            // MACD filter
            if (params.maxMacdHist > 0 && indicators.macdHist != null && Math.abs(indicators.macdHist) > params.maxMacdHist) {
                const elapsed = formatElapsed(Date.now() - t0);
                const reason = `macd_${indicators.macdHist.toFixed(1)}`;
                logger.warn(`${counter} ${slug} — SKIP (${reason}) | ${indStr}${maxPriceStr} [${elapsed}]`);
                results.push({ marketId: market.market_id, slug: market.slug || '', startTime: market.start_time, endTime: market.end_time, status: 'skipped', skipReason: reason, pnl: 0, maxPriceUp, maxPriceDown, ...indicators });
                continue;
            }

            // ATR filter
            if (params.maxAtr > 0 && indicators.atr14 != null && indicators.atr14 > params.maxAtr) {
                const elapsed = formatElapsed(Date.now() - t0);
                const reason = `atr_${indicators.atr14.toFixed(1)}`;
                logger.warn(`${counter} ${slug} — SKIP (${reason}) | ${indStr}${maxPriceStr} [${elapsed}]`);
                results.push({ marketId: market.market_id, slug: market.slug || '', startTime: market.start_time, endTime: market.end_time, status: 'skipped', skipReason: reason, pnl: 0, maxPriceUp, maxPriceDown, ...indicators });
                continue;
            }

            // BBW filter
            if (params.maxBbw > 0 && indicators.bbw20 != null && indicators.bbw20 > params.maxBbw) {
                const elapsed = formatElapsed(Date.now() - t0);
                const reason = `bbw_${(indicators.bbw20 * 100).toFixed(3)}%`;
                logger.warn(`${counter} ${slug} — SKIP (${reason}) | ${indStr}${maxPriceStr} [${elapsed}]`);
                results.push({ marketId: market.market_id, slug: market.slug || '', startTime: market.start_time, endTime: market.end_time, status: 'skipped', skipReason: reason, pnl: 0, maxPriceUp, maxPriceDown, ...indicators });
                continue;
            }

            // BTC delta filter
            if (params.maxDelta3m > 0 && indicators.btcPriceDelta3m != null && Math.abs(indicators.btcPriceDelta3m) > params.maxDelta3m) {
                const elapsed = formatElapsed(Date.now() - t0);
                const reason = `delta3m_${indicators.btcPriceDelta3m.toFixed(0)}`;
                logger.warn(`${counter} ${slug} — SKIP (${reason}) | ${indStr}${maxPriceStr} [${elapsed}]`);
                results.push({ marketId: market.market_id, slug: market.slug || '', startTime: market.start_time, endTime: market.end_time, status: 'skipped', skipReason: reason, pnl: 0, maxPriceUp, maxPriceDown, ...indicators });
                continue;
            }

            const result = simulateMomentumStandalone(market, snapshots, params);
            Object.assign(result, indicators);
            results.push(result);

            const elapsed = formatElapsed(Date.now() - t0);

            if (result.status === 'skipped') {
                const reason = result.skipReason || 'unknown';
                logger.warn(`${counter} ${slug} — SKIP (${reason}) | ${indStr}${maxPriceStr} [${elapsed}]`);
            } else {
                runningPnl += result.pnl;
                const exitLabel = EXIT_LABELS[result.exitType] || result.exitType;
                const sideStr = result.entrySide ? ` ${result.entrySide.toUpperCase()}` : '';
                const entryStr = result.entrySecondsFromStart != null ? ` @${result.entrySecondsFromStart}s` : '';
                const pnlStr = formatPnl(result.pnl);
                const totalStr = formatPnl(runningPnl);
                const logFn = result.pnl > 0 ? logger.money : result.pnl < 0 ? logger.warn : logger.info;
                logFn(`${counter} ${slug} — ${exitLabel}${sideStr}${entryStr} ${pnlStr} | ${indStr}${maxPriceStr} | cumulative: ${totalStr} [${elapsed}]`);
            }
        } catch (err) {
            const elapsed = formatElapsed(Date.now() - t0);
            logger.error(`${counter} ${slug} — ERROR: ${err.message} [${elapsed}]`);
            results.push({ marketId: market.market_id, slug: market.slug || '', startTime: market.start_time, endTime: market.end_time, status: 'skipped', skipReason: `error: ${err.message}`, pnl: 0 });
        }
    }

    console.log('');

    const summary = computeSummary(results, params);

    logger.info('═══════════════════════════════════════════');
    logger.info('      MM-MOMENTUM BACKTEST RESULTS');
    logger.info('═══════════════════════════════════════════');
    logger.info(`Duration:          ${params.duration}`);
    logger.info(`Total Markets:     ${summary.totalMarkets}`);
    logger.info(`Entered:           ${summary.enteredMarkets}`);
    logger.info(`Skipped:           ${summary.skippedMarkets}`);
    logger.info('───────────────────────────────────────────');
    logger.info(`Target Hit:        ${summary.targetHitCount} (${summary.targetHitRate}%)`);
    logger.info(`Trail Stop:        ${summary.trailStopCount}`);
    logger.info(`Cut Loss:          ${summary.cutLossCount}`);
    logger.info(`Expiry:            ${summary.expiryCount}`);
    logger.info('───────────────────────────────────────────');
    logger.info(`YES Entries:       ${summary.yesEntries}`);
    logger.info(`NO Entries:        ${summary.noEntries}`);
    logger.info(`Avg Entry Time:    ${summary.avgEntryTime}s`);
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
    logger.info('═══════════════════════════════════════════');

    try {
        const filepath = writeBacktestExcel(results, summary, params.duration);
        logger.success(`Excel written: ${filepath}`);
    } catch (err) {
        logger.error(`Failed to write Excel: ${err.message}`);
    }
}

main().catch((err) => {
    logger.error(`Momentum backtest failed: ${err.message}`);
    console.error(err);
    process.exit(1);
});
