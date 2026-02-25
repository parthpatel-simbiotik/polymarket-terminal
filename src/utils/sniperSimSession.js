/**
 * sniperSimSession.js
 * Tracks simulation balance and session data for Sniper dry-run.
 * Records snipe orders and cost events; writes Excel per session on exit.
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
 * @param {{ assets?: string }} [opts] - e.g. { assets: 'eth,sol,xrp' }
 */
export function startSession(startingBalance, opts = {}) {
    const bal = Number(startingBalance);
    if (Number.isNaN(bal) || bal < 0) throw new Error('startSession: startingBalance must be a non-negative number');
    const { assets = '' } = opts;
    session = {
        id: new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19),
        startTime: nowIso(),
        endTime: null,
        startBalance: bal,
        balance: bal,
        assets: String(assets).replace(/,/g, '_') || 'eth_sol_xrp',
        records: [],
        snipes: [],
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
 * @param {string} opts.type - e.g. 'place_snipe', 'redeem_win'
 * @param {string} [opts.description]
 * @param {number} opts.amount - signed: positive = credit, negative = debit
 * @param {string} [opts.market]
 * @param {string} [opts.side] - UP / DOWN
 * @param {number} [opts.shares]
 * @param {number} [opts.price]
 */
export function recordEvent(opts) {
    if (!session) return;
    const { type, description, amount, market, side, shares, price } = opts;
    const numAmount = Number(amount);
    if (!Number.isNaN(numAmount)) session.balance += numAmount;
    const balanceAfter = session.balance;

    session.records.push({
        time: nowIso(),
        type: type || '',
        description: description || '',
        amount: numAmount,
        balance_after: balanceAfter,
        market: market || '',
        side: side || '',
        shares: shares != null ? Number(shares) : '',
        price: price != null ? Number(price) : '',
    });
}

/**
 * Record a snipe order (GTC BUY placed).
 */
export function recordSnipe(opts) {
    if (!session) return;
    session.snipes.push({ time: nowIso(), ...opts });
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

    // Summary
    const totalPnl = (data.balance - data.startBalance);
    const summary = [
        ['Sniper Simulation Session Summary', ''],
        ['Session ID', data.id],
        ['Assets', data.assets || ''],
        ['Start', data.startTime],
        ['End', data.endTime || ''],
        ['Start Balance (USDC)', data.startBalance],
        ['End Balance (USDC)', data.balance],
        ['Total PnL (USDC)', totalPnl],
        ['', ''],
        ['Records', data.records.length],
        ['Snipes', data.snipes.length],
    ];
    const wsSummary = XLSX.utils.aoa_to_sheet(summary);
    XLSX.utils.book_append_sheet(wb, wsSummary, 'Summary');

    // Records (events with amount, balance)
    const recordRows = [
        ['Time', 'Type', 'Description', 'Amount', 'Balance After', 'Market', 'Side', 'Shares', 'Price'],
        ...data.records.map((r) => [
            r.time,
            r.type,
            r.description,
            r.amount,
            r.balance_after,
            r.market,
            r.side,
            r.shares !== '' ? r.shares : '',
            r.price !== '' ? r.price : '',
        ]),
    ];
    const wsRecords = XLSX.utils.aoa_to_sheet(recordRows);
    XLSX.utils.book_append_sheet(wb, wsRecords, 'Records');

    // Snipes
    if (data.snipes.length > 0) {
        const snipeKeys = ['time', 'asset', 'side', 'question', 'orderId', 'price', 'shares', 'cost', 'potentialPayout'];
        const snipeRows = [
            snipeKeys,
            ...data.snipes.map((s) => snipeKeys.map((k) => (s[k] != null ? s[k] : ''))),
        ];
        const wsSnipes = XLSX.utils.aoa_to_sheet(snipeRows);
        XLSX.utils.book_append_sheet(wb, wsSnipes, 'Snipes');
    }

    try {
        mkdirSync(outputDir, { recursive: true });
    } catch {
        // ignore
    }
    const assetsPart = data.assets ? `-${data.assets}` : '';
    const filename = `sniper-sim${assetsPart}-${data.id}.xlsx`;
    const filepath = join(outputDir, filename);
    XLSX.writeFile(wb, filepath);
    return filepath;
}
