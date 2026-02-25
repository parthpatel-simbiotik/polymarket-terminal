/**
 * dashboard.js
 * Terminal UI using readline + ANSI (no blessed).
 * Reference: PolymarketBTC15mAssistant — full-screen redraw for stability.
 */

import readline from 'node:readline';
import { appendFileSync, mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const LOG_DIR = join(__dirname, '../../data/logs');

// ── ANSI codes ─────────────────────────────────────────────────────────────
const ANSI = {
    reset: '\x1b[0m',
    bold: '\x1b[1m',
    dim: '\x1b[2m',
    red: '\x1b[31m',
    green: '\x1b[32m',
    yellow: '\x1b[33m',
    blue: '\x1b[34m',
    magenta: '\x1b[35m',
    cyan: '\x1b[36m',
    white: '\x1b[37m',
    gray: '\x1b[90m',
};

// ── State ───────────────────────────────────────────────────────────────────
let active = false;
let plainMode = false;
let logLines = [];
const MAX_LOG_LINES = 1000;
let statusLeftContent = '\n {gray}Initializing...{/gray}';
let statusRightContent = '\n {gray}Initializing...{/gray}';
const keyHandlers = new Map();
let lastStatusPrintMs = -60_000;
const STATUS_PRINT_INTERVAL_MS = 30_000;
let logFilePath = null;

function getLogFilePath() {
    if (logFilePath) return logFilePath;
    const mode = process.env.DRY_RUN === 'true' ? 'sim' : 'live';
    const duration = process.env.MM_DURATION?.toLowerCase();
    const assets = (process.env.MM_ASSETS || 'btc').replace(/,/g, '_').toLowerCase();
    const date = new Date().toISOString().slice(0, 10);
    const durationPart = duration && ['5m', '15m'].includes(duration) ? `-${duration}` : '';
    logFilePath = join(LOG_DIR, `events-${mode}${durationPart}-${assets}-${date}.log`);
    return logFilePath;
}

function appendToLogFile(text) {
    try {
        mkdirSync(LOG_DIR, { recursive: true });
        const plain = stripAnsi(blessedToAnsi(String(text)));
        appendFileSync(getLogFilePath(), plain + '\n', 'utf8');
    } catch {
        // ignore write errors
    }
}

// ── Helpers ─────────────────────────────────────────────────────────────────

function screenWidth() {
    const w = Number(process.stdout?.columns);
    return Number.isFinite(w) && w >= 40 ? w : 80;
}

function screenHeight() {
    const h = Number(process.stdout?.rows);
    return Number.isFinite(h) && h >= 10 ? h : 24;
}

function stripAnsi(s) {
    return String(s).replace(/\x1b\[[0-9;]*m/g, '');
}

/** Convert blessed-style tags to ANSI */
function blessedToAnsi(s) {
    return String(s)
        .replace(/\{bold\}/g, ANSI.bold)
        .replace(/\{\/bold\}/g, ANSI.reset)
        .replace(/\{green-fg\}/g, ANSI.green)
        .replace(/\{\/green-fg\}/g, ANSI.reset)
        .replace(/\{red-fg\}/g, ANSI.red)
        .replace(/\{\/red-fg\}/g, ANSI.reset)
        .replace(/\{yellow-fg\}/g, ANSI.yellow)
        .replace(/\{\/yellow-fg\}/g, ANSI.reset)
        .replace(/\{cyan-fg\}/g, ANSI.cyan)
        .replace(/\{\/cyan-fg\}/g, ANSI.reset)
        .replace(/\{blue-fg\}/g, ANSI.blue)
        .replace(/\{\/blue-fg\}/g, ANSI.reset)
        .replace(/\{gray-fg\}/g, ANSI.gray)
        .replace(/\{\/gray-fg\}/g, ANSI.reset)
        .replace(/\{magenta-fg\}/g, ANSI.magenta)
        .replace(/\{\/magenta-fg\}/g, ANSI.reset)
        .replace(/\{gray\}/g, ANSI.gray)
        .replace(/\{\/gray\}/g, ANSI.reset);
}

function padOrTruncate(str, width) {
    const plain = stripAnsi(str);
    if (plain.length >= width) {
        let visible = 0;
        let i = 0;
        while (i < str.length && visible < width) {
            if (str[i] === '\x1b' && str[i + 1] === '[') {
                const end = str.indexOf('m', i);
                i = end >= 0 ? end + 1 : i + 1;
            } else {
                visible++;
                i++;
            }
        }
        return str.slice(0, i);
    }
    return str + ' '.repeat(width - plain.length);
}

function getStatusBarContent() {
    const base =
        ` ${ANSI.gray}powered by${ANSI.reset} ${ANSI.cyan}@parthpatel5${ANSI.reset} ${ANSI.gray}terminal${ANSI.reset}` +
        `  ${ANSI.gray}Ctrl+C / q = exit${ANSI.reset}`;
    if (keyHandlers.has('x')) {
        return base + `  ${ANSI.gray}|  X = exit, redeem and quit${ANSI.reset}`;
    }
    return base;
}

export function initDashboard() {
    plainMode = !process.stdout.isTTY;

    // Key handling (only when TTY)
    if (process.stdin.isTTY) {
        try {
            process.stdin.setRawMode(true);
            readline.emitKeypressEvents(process.stdin);
            process.stdin.resume();
            process.stdin.setEncoding('utf8');

            process.stdin.on('keypress', (_str, key) => {
                if (!key) return;
                const k = (key.name || '').toLowerCase();
                if (key.ctrl && k === 'c') {
                    process.stdin.setRawMode(false);
                    process.exit(0);
                }
                if (k === 'q') {
                    process.stdin.setRawMode(false);
                    process.exit(0);
                }
                if (keyHandlers.has(k)) {
                    const fn = keyHandlers.get(k);
                    process.stdin.setRawMode(false);
                    Promise.resolve(fn())
                        .then(() => process.exit(0))
                        .catch((err) => {
                            console.error(err);
                            process.exit(1);
                        });
                }
            });
        } catch {
            // non-TTY, skip key handling
        }
    }

    // Redirect console
    console.log = (...a) => appendLog(a.join(' '));
    console.info = (...a) => appendLog(a.join(' '));
    console.warn = (...a) => appendLog(`${ANSI.yellow}${a.join(' ')}${ANSI.reset}`);
    console.error = (...a) => appendLog(`${ANSI.red}${a.join(' ')}${ANSI.reset}`);

    if (!plainMode) {
        process.stdout.on('resize', () => renderScreen());
    }

    active = true;
    statusLeftContent = '\n {gray}Initializing...{/gray}';
    statusRightContent = '\n {gray}Initializing...{/gray}';
    if (plainMode) {
        process.stdout.write(blessedToAnsi(statusContent.trim()) + '\n');
    } else {
        renderScreen();
    }

    return null;
}

/** Append a line to the live event log (and to log file) */
export function appendLog(text) {
    appendToLogFile(text);
    if (!active) {
        process.stdout.write(blessedToAnsi(String(text)) + '\n');
        return;
    }
    if (plainMode) {
        process.stdout.write(blessedToAnsi(String(text)) + '\n');
        return;
    }
    logLines.push(String(text));
    if (logLines.length > MAX_LOG_LINES) logLines = logLines.slice(-MAX_LOG_LINES);
    renderScreen();
}

/** Replace the top-panel content. Pass { left, right } for two columns or a string for legacy. */
export function updateStatus(content) {
    if (!active) return;
    if (typeof content === 'object' && content !== null && ('left' in content || 'right' in content)) {
        if (content.left !== undefined) statusLeftContent = content.left || '';
        if (content.right !== undefined) statusRightContent = content.right || '';
    } else {
        statusLeftContent = String(content || '');
        statusRightContent = '';
    }
    if (plainMode) {
        const now = Date.now();
        if (now - lastStatusPrintMs >= STATUS_PRINT_INTERVAL_MS) {
            lastStatusPrintMs = now;
            const leftLines = blessedToAnsi(statusLeftContent.trim()).split('\n');
            const rightLines = blessedToAnsi(statusRightContent.trim()).split('\n');
            process.stdout.write('--- STATUS ---\n');
            for (let i = 0; i < Math.max(leftLines.length, rightLines.length); i++) {
                process.stdout.write((leftLines[i] || '') + ' | ' + (rightLines[i] || '') + '\n');
            }
            process.stdout.write('---\n');
        }
        return;
    }
    renderScreen();
}

function renderScreen() {
    if (!active || plainMode) return;
    const w = screenWidth();
    const h = Math.max(12, screenHeight());

    try {
        process.stdout.write('\x1b[2J\x1b[H');
    } catch {
        return;
    }

    const fixedRows = 8;
    const totalContent = Math.max(2, h - fixedRows - 2);
    const statusRows = Math.max(6, Math.floor(totalContent * 0.45));
    const logRows = Math.max(2, totalContent - statusRows);

    const leftW = Math.floor(w * 0.45);
    const rightW = w - leftW - 3;
    const sep = ANSI.dim + '│' + ANSI.reset;

    const leftLines = statusLeftContent.trim().split('\n');
    const rightLines = statusRightContent.trim().split('\n');
    const visibleLog = logLines.slice(-logRows);

    const fullSep = ANSI.dim + '─'.repeat(Math.min(w, 200)) + ANSI.reset;
    const leftHeader = ANSI.yellow + ' BALANCE & CONFIG ' + ANSI.reset;
    const rightHeader = ANSI.yellow + ' ACTIVE POSITIONS ' + ANSI.reset;
    const logHeader = ANSI.cyan + ' LIVE EVENTS ' + ANSI.reset;

    const headerRow = padOrTruncate(leftHeader, leftW) + ' ' + sep + ' ' + padOrTruncate(rightHeader, rightW);
    const rows = [headerRow, fullSep];
    for (let i = 0; i < statusRows; i++) {
        const leftLine = leftLines[i] ?? '';
        const rightLine = rightLines[i] ?? '';
        const left = padOrTruncate(blessedToAnsi(leftLine), leftW);
        const right = padOrTruncate(blessedToAnsi(rightLine), rightW);
        rows.push(left + ' ' + sep + ' ' + right);
    }
    rows.push(fullSep, logHeader, fullSep);
    for (let i = 0; i < logRows; i++) {
        const line = visibleLog[i] ?? '';
        rows.push(padOrTruncate(blessedToAnsi(line), w));
    }

    const bar = padOrTruncate(getStatusBarContent(), w);
    const output = rows.join('\n') + '\n' + bar;
    const lineCount = output.split('\n').length;
    if (lineCount <= h) {
        process.stdout.write(output);
    } else {
        process.stdout.write(rows.slice(0, h - 1).join('\n') + '\n' + bar);
    }
}

export function isDashboardActive() {
    return active;
}

/**
 * Register a key handler. When the key is pressed, the async callback runs;
 * when it resolves, the app exits.
 */
export function registerKeyHandler(keyName, asyncCallback) {
    const k = String(keyName).toLowerCase();
    keyHandlers.set(k, asyncCallback);
}
