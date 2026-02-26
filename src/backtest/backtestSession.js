/**
 * backtestSession.js
 * Results tracking and Excel output for MM backtesting.
 * Adapted from mmSimSession.js for offline historical backtesting.
 */

import { mkdirSync } from 'fs';
import { dirname, join } from 'path';
import * as XLSX from 'xlsx';
import { fileURLToPath } from 'url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const DATA_DIR = join(__dirname, '../../data');

/**
 * Aggregate backtest results and compute summary statistics.
 * @param {Array} results - Array of per-market result objects from simulateMarket()
 * @param {object} params - Strategy parameters used
 * @returns {object} summary stats
 */
export function computeSummary(results, params) {
    const entered = results.filter((r) => r.status === 'closed');
    const skipped = results.filter((r) => r.status === 'skipped');
    const bothFilled = entered.filter((r) => r.exitType === 'both_filled');
    const merged = entered.filter((r) => r.exitType === 'merge');
    const cutLoss = entered.filter((r) => r.exitType === 'cut_loss' || r.exitType === 'cut_loss_recovery');
    const momentumAdd = entered.filter((r) => r.exitType === 'momentum_add');
    const momentumTrail = entered.filter((r) => r.exitType === 'momentum_trail');

    const totalPnl = entered.reduce((sum, r) => sum + r.pnl, 0);
    const wins = entered.filter((r) => r.pnl > 0);
    const losses = entered.filter((r) => r.pnl < 0);
    const breakeven = entered.filter((r) => r.pnl === 0);

    // P&L distribution
    const pnls = entered.map((r) => r.pnl).sort((a, b) => a - b);
    const maxWin = pnls.length > 0 ? pnls[pnls.length - 1] : 0;
    const maxLoss = pnls.length > 0 ? pnls[0] : 0;
    const avgPnl = entered.length > 0 ? totalPnl / entered.length : 0;

    // Cumulative P&L for max drawdown
    let peak = 0, maxDrawdown = 0, cumPnl = 0;
    for (const r of entered) {
        cumPnl += r.pnl;
        if (cumPnl > peak) peak = cumPnl;
        const dd = peak - cumPnl;
        if (dd > maxDrawdown) maxDrawdown = dd;
    }

    // Average spread at entry
    const spreads = entered
        .map((r) => r.entryPriceUp != null && r.entryPriceDown != null
            ? Math.abs(r.entryPriceUp - r.entryPriceDown) : null)
        .filter((v) => v != null);
    const avgSpread = spreads.length > 0 ? spreads.reduce((a, b) => a + b, 0) / spreads.length : 0;

    return {
        totalMarkets: results.length,
        enteredMarkets: entered.length,
        skippedMarkets: skipped.length,
        bothFilledCount: bothFilled.length,
        mergedCount: merged.length,
        cutLossCount: cutLoss.length,
        momentumAddCount: momentumAdd.length,
        momentumTrailCount: momentumTrail.length,
        bothFillRate: entered.length > 0 ? (bothFilled.length / entered.length * 100).toFixed(1) : '0.0',
        totalPnl,
        avgPnl,
        maxWin,
        maxLoss,
        maxDrawdown,
        winCount: wins.length,
        lossCount: losses.length,
        breakevenCount: breakeven.length,
        winRate: entered.length > 0 ? (wins.length / entered.length * 100).toFixed(1) : '0.0',
        avgSpreadAtEntry: avgSpread.toFixed(4),
        params,
    };
}

/**
 * Write backtest results to an Excel file.
 * @param {Array} results - Per-market result objects
 * @param {object} summary - Output from computeSummary()
 * @param {string} duration - '5m' or '15m'
 * @param {string} [outputDir] - default data/
 * @returns {string} path to written file
 */
export function writeBacktestExcel(results, summary, duration, outputDir = DATA_DIR) {
    const wb = XLSX.utils.book_new();

    // ── Summary sheet ────────────────────────────────────────────────
    const summaryData = [
        ['MM Backtest Summary', ''],
        ['', ''],
        ['Duration', duration],
        ['Total Markets', summary.totalMarkets],
        ['Entered Markets', summary.enteredMarkets],
        ['Skipped Markets', summary.skippedMarkets],
        ['', ''],
        ['── Results ──', ''],
        ['Both Filled', summary.bothFilledCount],
        ['Merged (P&L = $0)', summary.mergedCount],
        ['Cut Loss', summary.cutLossCount],
        ['Momentum Add', summary.momentumAddCount ?? 0],
        ['Momentum Trail', summary.momentumTrailCount ?? 0],
        ['Both-Fill Rate (%)', `${summary.bothFillRate}%`],
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
        ['Avg Spread at Entry', summary.avgSpreadAtEntry],
        ['', ''],
        ['── Strategy Params ──', ''],
        ['Sell Price', summary.params.sellPrice],
        ['Cut Loss (seconds)', summary.params.cutLossSeconds],
        ['Entry Window (seconds)', summary.params.entryWindow],
        ['Max Imbalance', summary.params.maxImbalance],
        ['Liquidity Check', summary.params.liquidityCheck],
        ['Trade Size (per side)', summary.params.tradeSize],
        ['Recovery', summary.params.recovery],
        ['Strategy', summary.params.strategy ?? 'mm'],
        ['Momentum Mode', summary.params.momentumMode ?? ''],
        ['Momentum Lookback', summary.params.momentumLookback ?? ''],
        ['Add Target', summary.params.addTarget ?? ''],
    ];
    const wsSummary = XLSX.utils.aoa_to_sheet(summaryData);
    XLSX.utils.book_append_sheet(wb, wsSummary, 'Summary');

    // ── Positions sheet (entered markets) ────────────────────────────
    const entered = results.filter((r) => r.status === 'closed');
    if (entered.length > 0) {
        const posKeys = [
            'marketId', 'slug', 'startTime', 'endTime', 'winner',
            'btcPriceStart', 'btcPriceEnd', 'finalVolume', 'finalLiquidity',
            'entryPriceUp', 'entryPriceDown',
            'maxPriceUp', 'maxPriceDown',
            'yesFilled', 'noFilled', 'yesFillPrice', 'noFillPrice',
            'yesFillTime', 'noFillTime',
            'exitType', 'exitPriceUp', 'exitPriceDown',
            'yesPnl', 'noPnl', 'pnl',
            'orderbookDepthAtEntry',
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

    // ── Skipped Markets sheet ────────────────────────────────────────
    const skipped = results.filter((r) => r.status === 'skipped');
    if (skipped.length > 0) {
        const skipKeys = ['marketId', 'slug', 'startTime', 'endTime', 'skipReason',
            'entryPriceUp', 'entryPriceDown', 'maxPriceUp', 'maxPriceDown',
            'finalVolume', 'finalLiquidity'];
        const skipRows = [
            skipKeys,
            ...skipped.map((r) => skipKeys.map((k) => r[k] != null ? r[k] : '')),
        ];
        const wsSkipped = XLSX.utils.aoa_to_sheet(skipRows);
        XLSX.utils.book_append_sheet(wb, wsSkipped, 'Skipped Markets');
    }

    // ── Write file ───────────────────────────────────────────────────
    try {
        mkdirSync(outputDir, { recursive: true });
    } catch { /* ignore */ }

    const ts = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
    const filename = `mm-backtest-btc-${duration}-${ts}.xlsx`;
    const filepath = join(outputDir, filename);
    XLSX.writeFile(wb, filepath);
    return filepath;
}
