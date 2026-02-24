import { createRequire } from 'module';
const require = createRequire(import.meta.url);
const blessed = require('blessed');

let screen     = null;
let logBox     = null;
let statusBox  = null;
let statusBar  = null;
let active     = false;
const keyHandlers = new Map();

function getStatusBarContent() {
    const base =
        ' {gray-fg}powered by{/gray-fg} {cyan-fg}@direkturcrypto | @parthpatel5{/cyan-fg} {gray-fg}terminal{/gray-fg}' +
        '  {gray-fg}Ctrl+C / q = exit{/gray-fg}';
    if (keyHandlers.has('x')) {
        return base + '  {gray-fg}|  X = exit, redeem and quit{/gray-fg}';
    }
    return base;
}

export function initDashboard() {
    screen = blessed.screen({
        smartCSR: false,   // avoid complex cursor escape sequences
        title: 'Polymarket Copy Trade',
        fullUnicode: true,
        forceUnicode: true,
    });

    // ── Left panel: event log (60%) ────────────────────────────
    // blessed.log auto-tails (newest line always at bottom).
    // Keys are swallowed globally via screen.on('keypress') below,
    // so no raw escape codes can leak into this widget.
    logBox = blessed.log({
        parent: screen,
        label: ' LIVE EVENTS ',
        left: 0,
        top: 0,
        width: '60%',
        height: '100%-1',
        border: { type: 'line' },
        tags: true,
        scrollable: true,
        alwaysScroll: true,
        mouse: false,
        keys: false,
        input: false,
        style: {
            border: { fg: 'cyan' },
            label: { fg: 'cyan', bold: true },
        },
    });

    // ── Right panel: positions & balance (40%) ─────────────────
    statusBox = blessed.box({
        parent: screen,
        label: ' POSITIONS & BALANCE ',
        left: '60%',
        top: 0,
        width: '40%',
        height: '100%-1',
        border: { type: 'line' },
        tags: true,
        scrollable: false,
        input: false,
        clickable: false,
        style: {
            border: { fg: 'yellow' },
            label: { fg: 'yellow', bold: true },
        },
        content: '\n {gray-fg}Initializing...{/gray-fg}',
    });

    // ── Bottom status bar ──────────────────────────────────────
    statusBar = blessed.box({
        parent: screen,
        bottom: 0,
        left: 0,
        width: '100%',
        height: 1,
        tags: true,
        content: getStatusBarContent(),
        style: { bg: 'black', fg: 'white' },
    });

    // ── Capture ALL keypresses at screen level ─────────────────
    // This prevents any raw escape sequence from leaking into panels
    screen.on('keypress', (_ch, key) => {
        if (!key) return;
        const k = (key.name || '').toLowerCase();
        if (key.full === 'C-c' || key.sequence === '\x03' || k === 'q') {
            screen.destroy();
            process.exit(0);
        }
        if (keyHandlers.has(k)) {
            const fn = keyHandlers.get(k);
            Promise.resolve(fn())
                .then(() => {
                    screen.destroy();
                    process.exit(0);
                })
                .catch((err) => {
                    console.error(err);
                    screen.destroy();
                    process.exit(1);
                });
            return;
        }
        // every other key: swallowed here, never reaches any widget
    });

    // Redirect raw console so nothing bypasses the TUI
    console.log   = (...a) => appendLog(a.join(' '));
    console.info  = (...a) => appendLog(a.join(' '));
    console.warn  = (...a) => appendLog(`{yellow-fg}${a.join(' ')}{/yellow-fg}`);
    console.error = (...a) => appendLog(`{red-fg}${a.join(' ')}{/red-fg}`);

    active = true;
    screen.render();

    // Force a clean redraw after the event loop starts — fixes the
    // "looks messy until resized" issue common in blessed on first paint.
    setTimeout(() => {
        screen.alloc();   // reallocate internal screen buffer
        screen.render();
    }, 50);

    return screen;
}

/** Append a line to the live event log (auto-tails to newest) */
export function appendLog(text) {
    if (!active || !logBox) {
        process.stdout.write(String(text) + '\n');
        return;
    }
    logBox.log(String(text));
    screen.render();
}

/** Replace the right-panel content */
export function updateStatus(content) {
    if (!active || !statusBox) return;
    statusBox.setContent(content);
    screen.render();
}

export function isDashboardActive() {
    return active;
}

/**
 * Register a key handler. When the key is pressed, the async callback runs;
 * when it resolves, the app exits. Used by MM for "X = exit positions (merge) and quit".
 * @param {string} keyName - e.g. 'x'
 * @param {() => Promise<void>} asyncCallback
 */
export function registerKeyHandler(keyName, asyncCallback) {
    const k = String(keyName).toLowerCase();
    keyHandlers.set(k, asyncCallback);
    if (statusBar) {
        statusBar.setContent(getStatusBarContent());
        if (screen) screen.render();
    }
}
