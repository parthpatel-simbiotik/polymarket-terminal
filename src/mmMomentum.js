/**
 * mmMomentum.js
 * Entry point for the MM-Momentum bot — directional momentum strategy.
 * Watches for price breakouts above a threshold, buys the momentum side,
 * and rides to an exit target or trail stop.
 *
 * Run with: npm run mom       (live)
 *           npm run mom-sim   (simulation / dry-run)
 *           npm run mom-sim -- --balance 500 --assets btc,eth
 */

import { validateMomentumConfig } from './config/index.js';
import config from './config/index.js';
import logger from './utils/logger.js';
import { initClient, getClient } from './services/client.js';
import { initDashboard, appendLog, updateStatus, isDashboardActive, registerKeyHandler } from './ui/dashboard.js';
import { executeMomentumStrategy, getActiveMomentumPositions, getWatchingMarkets, waitForActivePositionsToClose } from './services/mmMomentumExecutor.js';
import { getUsdcBalance } from './services/client.js';
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
            config.momAssets = assets;
        }
    }
}

// ── Validate config ────────────────────────────────────────────────────────────

try {
    validateMomentumConfig();
} catch (err) {
    console.error(`Config error: ${err.message}`);
    process.exit(1);
}

// ── Init TUI ──────────────────────────────────────────────────────────────────

initDashboard({ bot: 'mom' });
logger.setOutput(appendLog);

registerKeyHandler('x', async () => {
    logger.warn('MOM: exiting and quitting...');
    stopDetector();
    if (refreshTimer) clearInterval(refreshTimer);
    await waitForActivePositionsToClose();
    const data = endSession();
    if (data) {
        try {
            const path = writeSessionExcel(data);
            logger.info(`MOM: session saved to ${path}`);
        } catch (e) {
            logger.error(`MOM: failed to write session Excel: ${e.message}`);
        }
    }
    logger.info('MOM: quitting in 2s...');
    await new Promise((r) => setTimeout(r, 2000));
});

// ── Init CLOB client ──────────────────────────────────────────────────────────

try {
    await initClient();
} catch (err) {
    logger.error(`Client init error: ${err.message}`);
    process.exit(1);
}

// ── Session tracking (sim and live) ───────────────────────────────────────────
{
    const startBal = config.dryRun ? config.simBalance : 0;
    startSession(startBal, {
        assets: config.momAssets.join(','),
        duration: config.momDuration,
        strategy: 'mom',
    });
    if (config.dryRun) {
        logger.info(`MOM[SIM]: session started | balance $${config.simBalance.toFixed(2)} | assets: ${config.momAssets.join(', ').toUpperCase()} | ${config.momDuration}`);
    }
}

// ── Detector: uses same slug construction as mmDetector ───────────────────────

const SLOT_SEC = config.momDuration === '15m' ? 900 : 300;
const seenKeys = new Set();
let pollTimer = null;

function currentSlot() {
    return Math.floor(Date.now() / 1000 / SLOT_SEC) * SLOT_SEC;
}

function nextSlot() {
    return currentSlot() + SLOT_SEC;
}

async function fetchBySlug(asset, slotTimestamp) {
    const slug = `${asset}-updown-${config.momDuration}-${slotTimestamp}`;
    try {
        const resp = await fetch(`${config.gammaHost}/markets/slug/${slug}`);
        if (!resp.ok) return null;
        const data = await resp.json();
        return data?.conditionId ? data : null;
    } catch {
        return null;
    }
}

function extractMarketData(market, asset) {
    const conditionId = market.conditionId || market.condition_id || '';
    if (!conditionId) return null;

    let tokenIds = market.clobTokenIds ?? market.clob_token_ids;
    if (typeof tokenIds === 'string') {
        try { tokenIds = JSON.parse(tokenIds); } catch { tokenIds = null; }
    }

    let yesTokenId, noTokenId;
    if (Array.isArray(tokenIds) && tokenIds.length >= 2) {
        [yesTokenId, noTokenId] = tokenIds;
    } else if (Array.isArray(market.tokens) && market.tokens.length >= 2) {
        yesTokenId = market.tokens[0]?.token_id ?? market.tokens[0]?.tokenId;
        noTokenId  = market.tokens[1]?.token_id ?? market.tokens[1]?.tokenId;
    }

    if (!yesTokenId || !noTokenId) return null;

    return {
        asset,
        conditionId,
        question:       market.question || market.title || '',
        endTime:        market.endDate  || market.end_date_iso || market.endDateIso,
        eventStartTime: market.eventStartTime || market.event_start_time,
        yesTokenId:     String(yesTokenId),
        noTokenId:      String(noTokenId),
        negRisk:        market.negRisk  ?? market.neg_risk  ?? false,
        tickSize:       String(market.orderPriceMinTickSize ?? market.minimum_tick_size ?? market.minimumTickSize ?? '0.01'),
    };
}

async function scheduleAsset(asset, slotTimestamp) {
    const key = `${asset}-${slotTimestamp}`;
    if (seenKeys.has(key)) return;

    const market = await fetchBySlug(asset, slotTimestamp);
    if (!market) return;

    const data = extractMarketData(market, asset);
    if (!data) {
        logger.warn(`MOM: skipping ${asset.toUpperCase()} slot ${slotTimestamp} — missing token IDs`);
        seenKeys.add(key);
        return;
    }

    seenKeys.add(key);

    const openAt = data.eventStartTime ? new Date(data.eventStartTime).getTime() : slotTimestamp * 1000;
    const elapsedSec = Math.round((Date.now() - openAt) / 1000);
    if (elapsedSec > 15) {
        logger.info(`MOM: ${asset.toUpperCase()} next slot already ${elapsedSec}s old — skipping`);
        return;
    }

    const secsUntilOpen = Math.round((openAt - Date.now()) / 1000);
    if (secsUntilOpen > 0) {
        logger.success(`MOM: ${asset.toUpperCase()} found "${data.question.slice(0, 40)}" — watching (${secsUntilOpen}s before open)`);
    } else {
        logger.success(`MOM: ${asset.toUpperCase()} found "${data.question.slice(0, 40)}" — watching now`);
    }

    handleNewMarket(data);
}

async function poll() {
    try {
        const next = nextSlot();
        await Promise.all(config.momAssets.map((asset) => scheduleAsset(asset, next)));
    } catch (err) {
        logger.error('MOM detector poll error:', err.message);
    }
}

function startDetector() {
    seenKeys.clear();
    poll();
    pollTimer = setInterval(poll, config.momPollInterval);

    const ns = nextSlot();
    const secsUntil = ns - Math.floor(Date.now() / 1000);
    logger.info(`MOM detector started — assets: ${config.momAssets.join(', ').toUpperCase()} | duration: ${config.momDuration}`);
    logger.info(`Next slot: *-updown-${config.momDuration}-${ns} (opens in ${secsUntil}s)`);
    logger.info(`Strategy: buy above $${config.momEntryThreshold} → sell at $${config.momExitTarget} | size $${config.momTradeSize} | trail: ${config.momTrailEnabled ? 'ON' : 'OFF'} (${(config.momTrailDropPct * 100).toFixed(0)}%)`);
}

function stopDetector() {
    if (pollTimer) {
        clearInterval(pollTimer);
        pollTimer = null;
    }
}

// ── Market handler with per-asset queue ──────────────────────────────────────

const pendingByAsset = new Map();

async function runStrategy(market) {
    try {
        await executeMomentumStrategy(market);
    } catch (err) {
        logger.error(`MOM strategy error (${market.asset?.toUpperCase()}): ${err.message}`);
    }

    const queued = pendingByAsset.get(market.asset);
    if (queued) {
        pendingByAsset.delete(market.asset);
        const endMs = new Date(queued.endTime).getTime();
        const secsLeft = Math.round((endMs - Date.now()) / 1000);

        if (secsLeft > config.momCutLossTime) {
            logger.success(`MOM[${market.asset?.toUpperCase()}]: position cleared — executing queued`);
            runStrategy(queued);
        } else {
            logger.warn(`MOM[${market.asset?.toUpperCase()}]: queued market expired — discarding`);
        }
    }
}

function handleNewMarket(market) {
    const active = getActiveMomentumPositions();
    const isAssetBusy = active.some((p) => p.asset === market.asset);

    if (isAssetBusy) {
        pendingByAsset.set(market.asset, market);
        logger.warn(`MOM[${market.asset?.toUpperCase()}]: queued — will enter after current position clears`);
        return;
    }

    runStrategy(market);
}

// ── Status panel refresh ──────────────────────────────────────────────────────

async function buildStatusContent() {
    const leftLines = [];
    const rightLines = [];

    let cashBalance = 0;
    if (!config.dryRun) {
        try { cashBalance = await getUsdcBalance(); } catch { /* ignore */ }
    } else {
        cashBalance = getBalance();
    }

    // Compute unrealized P&L from open positions (cache prices for reuse in right panel)
    const positions = getActiveMomentumPositions();
    const livePrices = new Map();
    let positionsValue = 0;
    for (const pos of positions) {
        try {
            const client = getClient();
            const mp = await client.getMidpoint(pos.tokenId);
            const livePrice = parseFloat(mp?.mid ?? mp ?? '0') || 0;
            livePrices.set(pos.conditionId, livePrice);
            positionsValue += livePrice * pos.shares;
        } catch {
            livePrices.set(pos.conditionId, pos.entryPrice);
            positionsValue += pos.entryPrice * pos.shares;
        }
    }

    const totalValue = cashBalance + positionsValue;
    const simTag = config.dryRun ? ' {gray-fg}(sim){/gray-fg}' : '';

    leftLines.push(`{bold}BALANCE{/bold}`);
    leftLines.push(`  Cash   : {green-fg}$${cashBalance.toFixed(2)}{/green-fg}${simTag}`);
    if (positions.length > 0) {
        leftLines.push(`  In pos : {cyan-fg}$${positionsValue.toFixed(2)}{/cyan-fg}`);
    }
    leftLines.push(`  Total  : {bold}{green-fg}$${totalValue.toFixed(2)}{/green-fg}{/bold}`);
    leftLines.push('');

    leftLines.push(`{bold}MODE{/bold}`);
    leftLines.push(`  {magenta-fg}MM-MOMENTUM{/magenta-fg} ${config.dryRun ? '{yellow-fg}SIM{/yellow-fg}' : '{green-fg}LIVE{/green-fg}'}`);
    leftLines.push('');

    leftLines.push(`{bold}MOMENTUM CONFIG{/bold}`);
    leftLines.push(`  Assets    : ${config.momAssets.join(', ').toUpperCase()}`);
    leftLines.push(`  Duration  : ${config.momDuration}`);
    leftLines.push(`  Trade sz  : $${config.momTradeSize}`);
    leftLines.push(`  Entry >   : $${config.momEntryThreshold}`);
    leftLines.push(`  Exit @    : $${config.momExitTarget}`);
    leftLines.push(`  Window    : ${config.momEntryWindow}s`);
    leftLines.push(`  Cut loss  : ${config.momCutLossTime}s before close`);
    leftLines.push(`  Trail     : ${config.momTrailEnabled ? '{green-fg}ON{/green-fg}' : '{red-fg}OFF{/red-fg}'} (drop ${(config.momTrailDropPct * 100).toFixed(0)}%)`);

    const watching = getWatchingMarkets();
    rightLines.push(`{bold}POSITIONS (${positions.length}){/bold}`);

    // Show markets currently being watched for breakout
    if (watching.length > 0) {
        for (const w of watching) {
            const assetTag = w.asset ? `[${w.asset.toUpperCase()}] ` : '';
            const label = (w.question || '').substring(0, 28);
            rightLines.push(`  {cyan-fg}${assetTag}${label}{/cyan-fg}`);
            const wm = Math.floor(w.secsLeft / 60);
            const ws = w.secsLeft % 60;
            const wCountdown = wm > 0 ? `${wm}m${ws}s` : `${ws}s`;
            if (w.status === 'waiting_open') {
                rightLines.push(`  {yellow-fg}Waiting for Open{/yellow-fg} {gray-fg}(${wCountdown}){/gray-fg}`);
            } else {
                const yColor = w.yesPrice >= config.momEntryThreshold ? 'green' : 'gray';
                const nColor = w.noPrice >= config.momEntryThreshold ? 'green' : 'gray';
                rightLines.push(`  {magenta-fg}Waiting for Breakout{/magenta-fg} {gray-fg}(${wCountdown} left){/gray-fg}`);
                rightLines.push(`  {${yColor}-fg}Y: $${w.yesPrice.toFixed(3)}{/${yColor}-fg} | {${nColor}-fg}N: $${w.noPrice.toFixed(3)}{/${nColor}-fg} | {gray-fg}need >${config.momEntryThreshold}{/gray-fg}`);
            }
            rightLines.push('');
        }
    }

    if (positions.length === 0 && watching.length === 0) {
        const ns = nextSlot();
        const secsUntil = ns - Math.floor(Date.now() / 1000);
        if (secsUntil > 0) {
            const m = Math.floor(secsUntil / 60);
            const s = secsUntil % 60;
            const countdown = m > 0 ? `${m}m${s}s` : `${s}s`;
            rightLines.push(`  {gray-fg}Waiting for market...{/gray-fg} {yellow-fg}${countdown}{/yellow-fg}`);
        } else {
            rightLines.push('  {gray-fg}Waiting for market...{/gray-fg}');
        }
    }

    if (positions.length > 0) {
        for (const pos of positions) {
            const assetTag = pos.asset ? `[${pos.asset.toUpperCase()}] ` : '';
            const label = pos.question.substring(0, 28);
            const msLeft = new Date(pos.endTime).getTime() - Date.now();
            const secsLeft = Math.max(0, Math.round(msLeft / 1000));
            const timeStr = secsLeft > 60
                ? `${Math.floor(secsLeft / 60)}m${secsLeft % 60}s`
                : `{red-fg}${secsLeft}s{/red-fg}`;

            const entryAtStr = pos.entrySecFromOpen != null ? ` | {gray-fg}entered @${pos.entrySecFromOpen}s{/gray-fg}` : '';
            rightLines.push(`  {cyan-fg}${assetTag}${label}{/cyan-fg}`);
            rightLines.push(`  ${pos.side.toUpperCase()} | entry $${pos.entryPrice.toFixed(3)} (${pos.shares.toFixed(2)}) | ${timeStr}${entryAtStr}`);

            const price = livePrices.get(pos.conditionId) || 0;
            if (price > 0) {
                const pnl = (price - pos.entryPrice) * pos.shares;
                const pnlColor = pnl >= 0 ? 'green' : 'red';
                rightLines.push(`  {gray-fg}live{/gray-fg} $${price.toFixed(3)} | {${pnlColor}-fg}P&L $${pnl.toFixed(2)}{/${pnlColor}-fg}`);
            }
            rightLines.push('');
        }
    }

    return {
        left: '\n' + leftLines.join('\n'),
        right: '\n' + rightLines.join('\n'),
    };
}

let refreshTimer = null;

function startRefresh() {
    refreshTimer = setInterval(async () => {
        if (!isDashboardActive()) return;
        const content = await buildStatusContent();
        updateStatus(content);
    }, 1000);
    buildStatusContent().then(updateStatus);
}

// ── Graceful shutdown ─────────────────────────────────────────────────────────

async function shutdown() {
    logger.warn('MOM: shutting down...');
    stopDetector();
    if (refreshTimer) clearInterval(refreshTimer);
    await waitForActivePositionsToClose();
    const data = endSession();
    if (data) {
        try {
            const path = writeSessionExcel(data);
            logger.info(`MOM: session saved to ${path}`);
        } catch (e) {
            logger.error(`MOM: failed to write session Excel: ${e.message}`);
        }
    }
}

process.on('SIGINT', () => shutdown().then(() => process.exit(0)).catch((e) => { console.error(e); process.exit(1); }));
process.on('SIGTERM', () => shutdown().then(() => process.exit(0)).catch((e) => { console.error(e); process.exit(1); }));

// ── Start ─────────────────────────────────────────────────────────────────────

logger.info(`MOM bot starting — ${config.dryRun ? 'SIMULATION MODE' : 'LIVE MODE'} | assets: ${config.momAssets.join(', ').toUpperCase()} | ${config.momDuration}`);
startRefresh();
startDetector();
