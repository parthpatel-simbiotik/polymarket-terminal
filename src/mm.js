/**
 * mm.js
 * Entry point for the Market Maker bot.
 * Detects new Bitcoin 5-minute markets and executes the MM strategy.
 * Run with: npm run mm       (live)
 *           npm run mm-sim   (simulation / dry-run)
 *           npm run mm-sim -- --balance 500   (sim with starting balance 500 USDC)
 *           npm run mm-sim -- --assets btc,eth   (dynamic assets)
 */

import { validateMMConfig } from './config/index.js';
import config from './config/index.js';
import logger from './utils/logger.js';
import { initClient, getClient } from './services/client.js';
import { initDashboard, appendLog, updateStatus, isDashboardActive, registerKeyHandler } from './ui/dashboard.js';
import { startMMDetector, stopMMDetector } from './services/mmDetector.js';
import { executeMMStrategy, getActiveMMPositions, waitForActivePositionsToClose } from './services/mmExecutor.js';
import { getUsdcBalance } from './services/client.js';
import { cleanupOpenPositions, redeemMMPositions, MIN_SHARES_PER_SIDE } from './services/ctf.js';
import { startSession, getSession, getBalance, endSession, writeSessionExcel } from './utils/mmSimSession.js';

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
            config.mmAssets = assets;
            process.env.MM_ASSETS = assets.join(',');
        }
    }
}
if (!process.env.MM_ASSETS) process.env.MM_ASSETS = config.mmAssets.join(',');

// ── Validate config ────────────────────────────────────────────────────────────

try {
    validateMMConfig();
} catch (err) {
    console.error(`Config error: ${err.message}`);
    process.exit(1);
}

// ── Init TUI ──────────────────────────────────────────────────────────────────

initDashboard();
logger.setOutput(appendLog);

// Press X: close positions, merge, redeem, then quit
registerKeyHandler('x', async () => {
    logger.warn('MM: exit positions (merge + redeem) and quit...');
    stopMMDetector();
    if (refreshTimer) clearInterval(refreshTimer);
    if (redeemTimer) clearInterval(redeemTimer);
    await cleanupOpenPositions(getClient(), {
        simPositions: config.dryRun ? getActiveMMPositions() : undefined,
    });
    if (config.dryRun) await waitForActivePositionsToClose();
    await redeemMMPositions();
    if (config.dryRun) {
        const data = endSession();
        if (data) {
            const path = writeSessionExcel(data);
            logger.info(`MM: session saved to ${path}`);
        }
    }
    logger.info('MM: quitting in 2s...');
    await new Promise((r) => setTimeout(r, 2000));
});

// ── Init CLOB client ──────────────────────────────────────────────────────────

try {
    await initClient();
} catch (err) {
    logger.error(`Client init error: ${err.message}`);
    process.exit(1);
}

// ── Validate MM_TRADE_SIZE minimum ────────────────────────────────────────────

if (config.mmTradeSize < MIN_SHARES_PER_SIDE) {
    logger.error(
        `MM_TRADE_SIZE=${config.mmTradeSize} is below Polymarket minimum of ${MIN_SHARES_PER_SIDE} shares. ` +
        `Set MM_TRADE_SIZE ≥ ${MIN_SHARES_PER_SIDE} in your .env and restart.`
    );
    process.exit(1);
}

// ── Simulation session (dry-run only) ─────────────────────────────────────────
if (config.dryRun) {
    startSession(config.simBalance, {
        assets: config.mmAssets.join(','),
        duration: config.mmDuration,
    });
    logger.info(`MM[SIM]: session started | balance $${config.simBalance.toFixed(2)} | assets: ${config.mmAssets.join(', ').toUpperCase()} | ${config.mmDuration}`);
}

// ── Cleanup leftover positions on startup ─────────────────────────────────────

try {
    await cleanupOpenPositions(getClient());
} catch (err) {
    logger.warn(`MM: startup cleanup failed (non-fatal): ${err.message}`);
}

// ── Status panel refresh ──────────────────────────────────────────────────────

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
    leftLines.push(`{bold}BALANCE{/bold}`);
    leftLines.push(`  USDC.e: {green-fg}$${balance}{/green-fg}`);
    leftLines.push('');

    // Left: Mode
    leftLines.push(`{bold}MODE{/bold}`);
    leftLines.push(`  ${config.dryRun ? '{yellow-fg}SIMULATION{/yellow-fg}' : '{green-fg}LIVE{/green-fg}'}`);
    leftLines.push('');

    // Left: MM Config
    leftLines.push(`{bold}MM CONFIG{/bold}`);
    leftLines.push(`  Assets   : ${config.mmAssets.join(', ').toUpperCase()}`);
    leftLines.push(`  Duration : ${config.mmDuration}`);
    leftLines.push(`  Trade sz : $${config.mmTradeSize} per side`);
    leftLines.push(`  Sell @   : $${config.mmSellPrice}`);
    leftLines.push(`  Cut loss : ${config.mmCutLossTime}s before close`);

    // Right: Active positions
    const positions = getActiveMMPositions();
    rightLines.push(`{bold}(${positions.length}){/bold}`);

    if (positions.length === 0) {
        rightLines.push('  {gray-fg}Waiting for market...{/gray-fg}');
    } else {
        for (const pos of positions) {
            const assetTag = pos.asset ? `[${pos.asset.toUpperCase()}] ` : '';
            const label = pos.question.substring(0, 28);
            const msLeft = new Date(pos.endTime).getTime() - Date.now();
            const secsLeft = Math.max(0, Math.round(msLeft / 1000));
            const timeStr = secsLeft > 60
                ? `${Math.floor(secsLeft / 60)}m${secsLeft % 60}s`
                : `{red-fg}${secsLeft}s{/red-fg}`;

            rightLines.push(`  {cyan-fg}${assetTag}${label}{/cyan-fg}`);
            rightLines.push(`  ${pos.status} | ${timeStr}`);

            // YES side
            const yFill = pos.yes.filled
                ? `{green-fg}FILLED @ $${pos.yes.fillPrice?.toFixed(3)}{/green-fg}`
                : `{yellow-fg}waiting $${config.mmSellPrice}{/yellow-fg}`;

            // NO side
            const nFill = pos.no.filled
                ? `{green-fg}FILLED @ $${pos.no.fillPrice?.toFixed(3)}{/green-fg}`
                : `{yellow-fg}waiting $${config.mmSellPrice}{/yellow-fg}`;
            rightLines.push(`  Y:${pos.yes.shares?.toFixed(2)}→${yFill} N:${pos.no.shares?.toFixed(2)}→${nFill}`);
            rightLines.push('');
        }
    }

    return {
        left: '\n' + leftLines.join('\n'),
        right: '\n' + rightLines.join('\n'),
    };
}

let refreshTimer = null;
let redeemTimer = null;

function startRefresh() {
    refreshTimer = setInterval(async () => {
        if (!isDashboardActive()) return;
        const content = await buildStatusContent();
        updateStatus(content);
    }, 3000);

    // Also do one immediate refresh
    buildStatusContent().then(updateStatus);
}

function startRedeemer() {
    // Run once immediately, then every redeemInterval (default 60s)
    redeemMMPositions().catch((err) => logger.error('MM redeemer error:', err.message));
    redeemTimer = setInterval(
        () => redeemMMPositions().catch((err) => logger.error('MM redeemer error:', err.message)),
        config.redeemInterval,
    );
    logger.info(`MM redeemer started — checking every ${config.redeemInterval / 1000}s`);
}

// ── Market handler with per-asset queue ──────────────────────────────────────

// Each asset can hold one pending market while its current position is active.
const pendingByAsset = new Map(); // asset → market

async function runStrategy(market) {
    try {
        await executeMMStrategy(market);
    } catch (err) {
        logger.error(`MM strategy error (${market.asset?.toUpperCase()}): ${err.message}`);
    }

    // After position clears, execute the queued market for this asset if still valid
    const queued = pendingByAsset.get(market.asset);
    if (queued) {
        pendingByAsset.delete(market.asset);

        const endMs = new Date(queued.endTime).getTime();
        const secsLeft = Math.round((endMs - Date.now()) / 1000);

        if (secsLeft > config.mmCutLossTime) {
            logger.success(
                `MM[${market.asset?.toUpperCase()}]: position cleared — ` +
                `executing queued "${queued.question.substring(0, 40)}" (${secsLeft}s left)`
            );
            runStrategy(queued); // non-blocking
        } else {
            logger.warn(
                `MM[${market.asset?.toUpperCase()}]: queued market "${queued.question.substring(0, 40)}" ` +
                `expired (${secsLeft}s left) — discarding`
            );
        }
    }
}

async function handleNewMarket(market) {
    const active = getActiveMMPositions();
    const isAssetBusy = active.some((p) => p.asset === market.asset);

    if (isAssetBusy) {
        // Queue this market for this asset — runs once the current position exits
        pendingByAsset.set(market.asset, market);
        logger.warn(
            `MM[${market.asset?.toUpperCase()}]: queued "${market.question.substring(0, 40)}" — ` +
            `will enter after current ${market.asset?.toUpperCase()} position clears`
        );
        return;
    }

    runStrategy(market); // non-blocking
}


// ── Graceful shutdown ─────────────────────────────────────────────────────────

async function shutdown() {
    logger.warn('MM: shutting down...');
    stopMMDetector();
    if (refreshTimer) clearInterval(refreshTimer);
    if (redeemTimer) clearInterval(redeemTimer);
    await cleanupOpenPositions(getClient(), {
        simPositions: config.dryRun ? getActiveMMPositions() : undefined,
    });
    if (config.dryRun) await waitForActivePositionsToClose();
    await redeemMMPositions();
    if (config.dryRun) {
        const data = endSession();
        if (data) {
            try {
                const path = writeSessionExcel(data);
                logger.info(`MM: session saved to ${path}`);
            } catch (e) {
                logger.error(`MM: failed to write session Excel: ${e.message}`);
            }
        }
    }
}

process.on('SIGINT', () => shutdown().then(() => process.exit(0)).catch((e) => { console.error(e); process.exit(1); }));
process.on('SIGTERM', () => shutdown().then(() => process.exit(0)).catch((e) => { console.error(e); process.exit(1); }));

// ── Start ─────────────────────────────────────────────────────────────────────

logger.info(`MM bot starting — ${config.dryRun ? 'SIMULATION MODE' : 'LIVE MODE'} | assets: ${config.mmAssets.join(', ').toUpperCase()} | ${config.mmDuration}`);
startRefresh();
startRedeemer();
startMMDetector(handleNewMarket);
