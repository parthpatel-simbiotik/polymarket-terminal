/**
 * mmSimSession.js
 * Tracks simulation balance and session data for MM dry-run.
 * Records orders, positions, and PnL events; writes Excel per session on exit.
 */

import { mkdirSync } from 'fs';
import { dirname, join } from 'path';
import * as XLSX from 'xlsx';
import { fileURLToPath } from 'url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const DATA_DIR = join(__dirname, '../../data');

let session = null;

function nowIso() {
    return new Date().toISOString();
}

/**
 * Start a new simulation session with starting balance.
 * @param {number} startingBalance - USDC
 * @param {{ assets?: string, duration?: string }} [opts] - e.g. { assets: 'btc,eth', duration: '5m' }
 */
export function startSession(startingBalance, opts = {}) {
    const bal = Number(startingBalance);
    if (Number.isNaN(bal) || bal < 0) throw new Error('startSession: startingBalance must be a non-negative number');
    const { assets = '', duration = '', strategy = 'mm' } = opts;
    session = {
        id: new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19),
        startTime: nowIso(),
        endTime: null,
        startBalance: bal,
        balance: bal,
        assets: String(assets).replace(/,/g, '_') || 'btc',
        duration: String(duration) || '5m',
        strategy: String(strategy),
        records: [],
        orders: [],
        positions: [],
    };
    return session;
}

/**
 * @returns {object|null} current session or null
 */
export function getSession() {
    return session;
}

/**
 * @returns {number} current sim balance (0 if no session)
 */
export function getBalance() {
    return session ? session.balance : 0;
}

/**
 * Apply a delta to balance and record the event.
 * @param {object} opts
 * @param {string} opts.type - e.g. 'split','merge','fill_yes','fill_no','cut_loss_sell','recovery_buy','recovery_sell'
 * @param {string} [opts.description]
 * @param {number} opts.amount - signed: positive = credit, negative = debit
 * @param {number} [opts.pnl]
 * @param {string} [opts.market]
 * @param {string} [opts.side] - YES / NO
 * @param {number} [opts.shares]
 * @param {number} [opts.price]
 */
export function recordEvent(opts) {
    if (!session) return;
    const { type, description, amount, pnl, market, side, shares, price } = opts;
    const prevBalance = session.balance;
    const numAmount = Number(amount);
    if (!Number.isNaN(numAmount)) session.balance += numAmount;
    const balanceAfter = session.balance;

    session.records.push({
        time: nowIso(),
        type: type || '',
        description: description || '',
        amount: numAmount,
        pnl: pnl != null ? Number(pnl) : '',
        balance_after: balanceAfter,
        market: market || '',
        side: side || '',
        shares: shares != null ? Number(shares) : '',
        price: price != null ? Number(price) : '',
    });
}

/**
 * Record an order (limit/market place or fill).
 */
export function recordOrder(opts) {
    if (!session) return;
    session.orders.push({ time: nowIso(), ...opts });
}

/**
 * Record a position open or close.
 */
export function recordPosition(opts) {
    if (!session) return;
    session.positions.push({ time: nowIso(), ...opts });
}

/**
 * End session and return snapshot (for Excel).
 */
export function endSession() {
    if (!session) return null;
    session.endTime = nowIso();
    const snap = { ...session };
    session = null;
    return snap;
}

/**
 * Write session data to an Excel file. Call after endSession() with its return value.
 * @param {object} data - snapshot from endSession()
 * @param {string} [outputDir] - default data/
 * @returns {string} path to written file
 */
export function writeSessionExcel(data, outputDir = DATA_DIR) {
    if (!data || !data.records) throw new Error('writeSessionExcel: invalid session data');

    const wb = XLSX.utils.book_new();

    // Summary — compute enhanced stats from positions
    const totalPnl = (data.balance - data.startBalance);
    const closedPositions = data.positions.filter((p) => p.status === 'closed');
    const bothFilledCount = closedPositions.filter((p) => p.exitType === 'both_filled').length;
    const totalClosed = closedPositions.length;
    const bothFillRate = totalClosed > 0 ? ((bothFilledCount / totalClosed) * 100).toFixed(1) : '0.0';

    const spreadsAtEntry = closedPositions
        .flatMap((p) => [p.yesSpreadAtEntry, p.noSpreadAtEntry])
        .filter((v) => v != null && !isNaN(v));
    const avgSpreadAtEntry = spreadsAtEntry.length > 0
        ? (spreadsAtEntry.reduce((a, b) => a + b, 0) / spreadsAtEntry.length).toFixed(4) : 'N/A';

    const skippedLiq = data.records.filter((r) => r.type === 'skip_low_liquidity').length;

    const firstFills = closedPositions.map((p) => p.timeToFirstFill).filter((v) => v != null);
    const avgFirstFill = firstFills.length > 0
        ? (firstFills.reduce((a, b) => a + b, 0) / firstFills.length).toFixed(1) : 'N/A';

    const secondFills = closedPositions.map((p) => p.timeToSecondFill).filter((v) => v != null);
    const avgSecondFill = secondFills.length > 0
        ? (secondFills.reduce((a, b) => a + b, 0) / secondFills.length).toFixed(1) : 'N/A';

    const summary = [
        ['MM Simulation Session Summary', ''],
        ['Session ID', data.id],
        ['Assets', data.assets || ''],
        ['Duration', data.duration || ''],
        ['Start', data.startTime],
        ['End', data.endTime || ''],
        ['Start Balance (USDC)', data.startBalance],
        ['End Balance (USDC)', data.balance],
        ['Total PnL (USDC)', totalPnl],
        ['', ''],
        ['Records', data.records.length],
        ['Orders', data.orders.length],
        ['Positions', data.positions.length],
        ['', ''],
        ['── Market Quality Metrics ──', ''],
        ['Both-Fill Rate (%)', `${bothFillRate}%`],
        ['Avg Spread at Entry', avgSpreadAtEntry],
        ['Markets Skipped (Low Liq)', skippedLiq],
        ['Avg Time to First Fill (s)', avgFirstFill],
        ['Avg Time to Second Fill (s)', avgSecondFill],
    ];
    const wsSummary = XLSX.utils.aoa_to_sheet(summary);
    XLSX.utils.book_append_sheet(wb, wsSummary, 'Summary');

    // Records (events with amount, pnl, balance)
    const recordRows = [
        ['Time', 'Type', 'Description', 'Amount', 'PnL', 'Balance After', 'Market', 'Side', 'Shares', 'Price'],
        ...data.records.map((r) => [
            r.time,
            r.type,
            r.description,
            r.amount,
            r.pnl !== '' ? r.pnl : '',
            r.balance_after,
            r.market,
            r.side,
            r.shares !== '' ? r.shares : '',
            r.price !== '' ? r.price : '',
        ]),
    ];
    const wsRecords = XLSX.utils.aoa_to_sheet(recordRows);
    XLSX.utils.book_append_sheet(wb, wsRecords, 'Records');

    // Orders (with new spread/midpoint columns)
    if (data.orders.length > 0) {
        const orderKeys = ['time', 'market', 'side', 'orderType', 'price', 'shares', 'status', 'pnl',
            'midpointAtFill', 'spreadAtFill', 'otherSideMidAtFill'];
        const orderRows = [
            orderKeys,
            ...data.orders.map((o) => orderKeys.map((k) => (o[k] != null ? o[k] : ''))),
        ];
        const wsOrders = XLSX.utils.aoa_to_sheet(orderRows);
        XLSX.utils.book_append_sheet(wb, wsOrders, 'Orders');
    }

    // Positions (with new tracking columns)
    if (data.positions.length > 0) {
        const posKeys = ['time', 'market', 'conditionId', 'entryCost', 'yesShares', 'noShares', 'status', 'exitReason', 'pnl', 'endTime',
            'yesSpreadAtEntry', 'noSpreadAtEntry', 'yesMidAtEntry', 'noMidAtEntry',
            'yesMidAtExit', 'noMidAtExit', 'exitType', 'fillCount', 'timeToFirstFill', 'timeToSecondFill'];
        const posRows = [
            posKeys,
            ...data.positions.map((p) => posKeys.map((k) => (p[k] != null ? p[k] : ''))),
        ];
        const wsPositions = XLSX.utils.aoa_to_sheet(posRows);
        XLSX.utils.book_append_sheet(wb, wsPositions, 'Positions');
    }

    try {
        mkdirSync(outputDir, { recursive: true });
    } catch {
        // ignore
    }
    const isMom = data.strategy === 'mom';
    const prefix = isMom ? 'mom' : 'mm';
    const duration = data.duration || '5m';
    const mode = data.startBalance > 0 ? 'sim' : 'live';
    const filename = `${prefix}-${duration}-${mode}-${data.id}.xlsx`;
    const filepath = join(outputDir, filename);
    XLSX.writeFile(wb, filepath);
    return filepath;
}
