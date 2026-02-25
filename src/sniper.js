/**
 * sniper.js
 * Entry point for the Orderbook Sniper bot.
 * Places tiny GTC BUY orders at $0.01 on both sides of ETH/SOL/XRP 5-min markets.
 *
 * Run with: npm run sniper       (live)
 *           npm run sniper-sim   (simulation)
 *           npm run sniper-sim -- --balance 500   (sim with starting balance 500 USDC)
 *           npm run sniper-sim -- --assets eth,sol,xrp   (dynamic assets)
 */

import { validateMMConfig } from './config/index.js';
import config from './config/index.js';
import logger from './utils/logger.js';
import { initClient } from './services/client.js';
import { getUsdcBalance } from './services/client.js';
import { initDashboard, appendLog, updateStatus, isDashboardActive, registerKeyHandler } from './ui/dashboard.js';
import { startSniperDetector, stopSniperDetector } from './services/sniperDetector.js';
import { executeSnipe, getActiveSnipes } from './services/sniperExecutor.js';
import { redeemMMPositions } from './services/ctf.js';
import { startSession, getBalance, endSession, writeSessionExcel } from './utils/sniperSimSession.js';

// ── Parse CLI ───────────────────────────────────────────────────────────────
const argv = process.argv.slice(2);
for (let i = 0; i < argv.length; i++) {
    if ((argv[i] === '--balance' || argv[i] === '-b') && argv[i + 1]) {
        const val = parseFloat(argv[i + 1]);
        if (!Number.isNaN(val) && val >= 0) config.simBalance = val;
    }
    if ((argv[i] === '--assets' || argv[i] === '-a') && argv[i + 1]) {
        const assets = argv[i + 1]
            .split(',')
            .map((s) => s.trim().toLowerCase())
            .filter(Boolean);
        if (assets.length > 0) {
            config.sniperAssets = assets;
            process.env.SNIPER_ASSETS = assets.join(',');
        }
    }
}
if (!process.env.SNIPER_ASSETS) process.env.SNIPER_ASSETS = config.sniperAssets.join(',');

// ── Validate config ────────────────────────────────────────────────────────────

try {
    validateMMConfig();
} catch (err) {
    console.error(`Config error: ${err.message}`);
    process.exit(1);
}

if (config.sniperAssets.length === 0) {
    console.error('SNIPER_ASSETS is empty. Set e.g. SNIPER_ASSETS=eth,sol,xrp in .env');
    process.exit(1);
}

// ── Init TUI ──────────────────────────────────────────────────────────────────

initDashboard({ bot: 'sniper' });
logger.setOutput(appendLog);

// Press X: redeem, save session Excel, then quit (sim only)
registerKeyHandler('x', async () => {
    logger.warn('SNIPER: redeem, save session and quit...');
    stopSniperDetector();
    if (refreshTimer) clearInterval(refreshTimer);
    if (redeemTimer) clearInterval(redeemTimer);
    await redeemMMPositions();
    if (config.dryRun) {
        const data = endSession();
        if (data) {
            try {
                const path = writeSessionExcel(data);
                logger.info(`SNIPER: session saved to ${path}`);
            } catch (e) {
                logger.error(`SNIPER: failed to write session Excel: ${e.message}`);
            }
        }
    }
    logger.info('SNIPER: quitting in 2s...');
    await new Promise((r) => setTimeout(r, 2000));
});

// ── Init CLOB client ──────────────────────────────────────────────────────────

try {
    await initClient();
} catch (err) {
    logger.error(`Client init error: ${err.message}`);
    process.exit(1);
}

// ── Simulation session (dry-run only) ─────────────────────────────────────────
if (config.dryRun) {
    startSession(config.simBalance, {
        assets: config.sniperAssets.join(','),
    });
    logger.info(`SNIPER[SIM]: session started | balance $${config.simBalance.toFixed(2)} | assets: ${config.sniperAssets.join(', ').toUpperCase()}`);
}

// ── Status panel ──────────────────────────────────────────────────────────────

async function buildStatusContent() {
    const leftLines = [];
    const rightLines = [];

    // Left: Balance
    let balance = '?';
    if (!config.dryRun) {
        try { balance = (await getUsdcBalance()).toFixed(2); } catch { /* ignore */ }
    } else {
        balance = `${getBalance().toFixed(2)} {gray-fg}(sim){/gray-fg}`;
    }
    leftLines.push('{bold}BALANCE{/bold}');
    leftLines.push(`  USDC.e: {green-fg}$${balance}{/green-fg}`);
    leftLines.push('');

    // Left: Mode
    leftLines.push('{bold}MODE{/bold}');
    leftLines.push(`  ${config.dryRun ? '{yellow-fg}SIMULATION{/yellow-fg}' : '{green-fg}LIVE{/green-fg}'}`);
    leftLines.push('');

    // Left: Sniper Config
    leftLines.push('{bold}SNIPER CONFIG{/bold}');
    leftLines.push(`  Assets : ${config.sniperAssets.join(', ').toUpperCase()}`);
    leftLines.push(`  Price  : $${config.sniperPrice} per share`);
    leftLines.push(`  Shares : ${config.sniperShares} per side`);
    leftLines.push(`  Cost   : $${(config.sniperPrice * config.sniperShares * 2 * config.sniperAssets.length).toFixed(3)} per slot`);

    // Right: Snipe orders
    const snipes = getActiveSnipes();
    rightLines.push(`{bold}SNIPE ORDERS (${snipes.length}){/bold}`);

    if (snipes.length === 0) {
        rightLines.push('  {gray-fg}Waiting for next slot...{/gray-fg}');
    } else {
        const recent = snipes.slice(-10).reverse();
        for (const s of recent) {
            const payout = s.potentialPayout.toFixed(2);
            rightLines.push(`  {cyan-fg}${s.asset}{/cyan-fg} ${s.side} @ $${s.price} × ${s.shares}sh | pay $${payout} if win`);
        }
    }

    return {
        left: '\n' + leftLines.join('\n'),
        right: '\n' + rightLines.join('\n'),
    };
}

let refreshTimer = null;
let redeemTimer  = null;

function startRefresh() {
    refreshTimer = setInterval(async () => {
        if (!isDashboardActive()) return;
        updateStatus(await buildStatusContent());
    }, 3000);
    buildStatusContent().then(updateStatus);
}

function startRedeemer() {
    redeemMMPositions().catch((err) => logger.error('Sniper redeemer error:', err.message));
    redeemTimer = setInterval(
        () => redeemMMPositions().catch((err) => logger.error('Sniper redeemer error:', err.message)),
        config.redeemInterval,
    );
    logger.info(`Sniper redeemer started — checking every ${config.redeemInterval / 1000}s`);
}

// ── Market handler ────────────────────────────────────────────────────────────

async function handleNewMarket(market) {
    executeSnipe(market).catch((err) =>
        logger.error(`SNIPER execute error (${market.asset}): ${err.message}`)
    );
}

// ── Graceful shutdown ─────────────────────────────────────────────────────────

async function shutdown() {
    logger.warn('SNIPER: shutting down...');
    stopSniperDetector();
    if (refreshTimer) clearInterval(refreshTimer);
    if (redeemTimer) clearInterval(redeemTimer);
    await redeemMMPositions();
    if (config.dryRun) {
        const data = endSession();
        if (data) {
            try {
                const path = writeSessionExcel(data);
                logger.info(`SNIPER: session saved to ${path}`);
            } catch (e) {
                logger.error(`SNIPER: failed to write session Excel: ${e.message}`);
            }
        }
    }
}

process.on('SIGINT', () => shutdown().then(() => process.exit(0)).catch((e) => { console.error(e); process.exit(1); }));
process.on('SIGTERM', () => shutdown().then(() => process.exit(0)).catch((e) => { console.error(e); process.exit(1); }));

// ── Start ─────────────────────────────────────────────────────────────────────

const costPerSlot = (config.sniperPrice * config.sniperShares * 2 * config.sniperAssets.length).toFixed(3);
logger.info(`SNIPER starting — ${config.dryRun ? 'SIMULATION' : 'LIVE'}`);
logger.info(`Assets: ${config.sniperAssets.join(', ').toUpperCase()} | $${config.sniperPrice} × ${config.sniperShares}sh = $${costPerSlot}/slot`);

startRefresh();
startRedeemer();
startSniperDetector(handleNewMarket);
