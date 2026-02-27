/**
 * mmMomentumExecutor.js
 * Directional momentum strategy for binary "Up or Down" markets:
 *   1. After market opens, poll prices within entry window
 *   2. If either UP or DOWN crosses above entry threshold → market-buy that side
 *   3. Hold until exit target (e.g. 0.98) or trail stop, or cut-loss before expiry
 *   4. One position at a time per asset
 *
 * Key difference from mmExecutor: no split/merge — directional buy of the momentum side only.
 */

import { Side, OrderType } from '@polymarket/clob-client';
import { ethers } from 'ethers';
import config from '../config/index.js';
import { getClient, getUsdcBalance, getPolygonProvider } from './client.js';
import logger from '../utils/logger.js';
import { recordEvent, recordOrder, recordPosition, getBalance } from '../utils/mmSimSession.js';

const CTF_ADDRESS = '0x4D97DCd97eC945f40cF65F87097ACe5EA0476045';
const CTF_BALANCE_ABI = ['function balanceOf(address account, uint256 id) view returns (uint256)'];

async function getTokenBalance(tokenId) {
    try {
        const provider = await getPolygonProvider();
        const ctf = new ethers.Contract(CTF_ADDRESS, CTF_BALANCE_ABI, provider);
        const raw = await ctf.balanceOf(config.proxyWallet, tokenId);
        return parseFloat(ethers.utils.formatUnits(raw, 6));
    } catch {
        return null;
    }
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const activePositions = new Map();
const watchingMarkets = new Map(); // asset → { question, yesPrice, noPrice, secsLeft, asset }

export function getActiveMomentumPositions() {
    return Array.from(activePositions.values());
}

export function getWatchingMarkets() {
    return Array.from(watchingMarkets.values());
}

export async function waitForActivePositionsToClose(maxMs = 20_000) {
    const deadline = Date.now() + maxMs;
    while (activePositions.size > 0 && Date.now() < deadline) {
        await sleep(500);
    }
}

// ── Order helpers ─────────────────────────────────────────────────────────────

async function marketBuy(tokenId, amount, tickSize, negRisk) {
    if (config.dryRun) {
        try {
            const client = getClient();
            const mp = await client.getMidpoint(tokenId);
            const mid = parseFloat(mp?.mid ?? mp ?? '0');
            // Use best ask from orderbook for more realistic sim fill
            const ob = await client.getOrderBook(tokenId);
            const asks = ob?.asks || [];
            let bestAsk = 0;
            for (const a of asks) {
                const p = parseFloat(a.price);
                if (p > 0 && (bestAsk === 0 || p < bestAsk)) bestAsk = p;
            }
            const fillPrice = bestAsk > 0 ? bestAsk : (mid > 0 ? mid : 0.50);
            const shares = amount / fillPrice;
            return { success: true, fillPrice, shares };
        } catch {
            return { success: true, fillPrice: 0.50, shares: amount / 0.50 };
        }
    }

    const client = getClient();
    try {
        const res = await client.createAndPostMarketOrder(
            { tokenID: tokenId, side: Side.BUY, amount, price: 0.99 },
            { tickSize, negRisk },
            OrderType.FOK,
        );
        if (!res?.success) return { success: false, fillPrice: 0, shares: 0 };
        const shares = parseFloat(res.takingAmount || '0');
        // Derive avg fill price from amount spent / shares received
        const apiPrice = parseFloat(res.price || '0');
        const fillPrice = shares > 0 ? amount / shares : (apiPrice > 0 ? apiPrice : 0);
        return { success: true, fillPrice, shares: shares > 0 ? shares : (fillPrice > 0 ? amount / fillPrice : 0) };
    } catch (err) {
        logger.error('MOM market buy error:', err.message);
        return { success: false, fillPrice: 0, shares: 0 };
    }
}

async function marketSell(tokenId, shares, tickSize, negRisk) {
    if (config.dryRun) {
        try {
            const client = getClient();
            const mp = await client.getMidpoint(tokenId);
            const price = parseFloat(mp?.mid ?? mp ?? '0') || 0.50;
            const proceeds = price * shares;
            return { success: true, fillPrice: price, proceeds };
        } catch {
            const proceeds = 0.50 * shares;
            return { success: true, fillPrice: 0.50, proceeds };
        }
    }

    const client = getClient();
    try {
        const res = await client.createAndPostMarketOrder(
            { tokenID: tokenId, side: Side.SELL, amount: shares, price: 0.01 },
            { tickSize, negRisk },
            OrderType.FOK,
        );
        if (!res?.success) return { success: false, fillPrice: 0, proceeds: 0 };
        const usdcReceived = parseFloat(res.takingAmount || '0');
        const sharesSold = parseFloat(res.makingAmount || '0') || shares;
        const apiPrice = parseFloat(res.price || '0');
        const fillPrice = usdcReceived > 0 ? usdcReceived / sharesSold : (apiPrice > 0 ? apiPrice : 0);
        const proceeds = usdcReceived > 0 ? usdcReceived : fillPrice * shares;
        return { success: true, fillPrice, proceeds };
    } catch (err) {
        logger.error('MOM market sell error:', err.message);
        return { success: false, fillPrice: 0, proceeds: 0 };
    }
}

// ── Price & orderbook helpers ─────────────────────────────────────────────────

async function getMidpoints(yesTokenId, noTokenId) {
    try {
        const client = getClient();
        const [yesMp, noMp] = await Promise.all([
            client.getMidpoint(yesTokenId),
            client.getMidpoint(noTokenId),
        ]);
        return {
            yes: parseFloat(yesMp?.mid ?? yesMp ?? '0') || 0,
            no: parseFloat(noMp?.mid ?? noMp ?? '0') || 0,
        };
    } catch {
        return { yes: 0, no: 0 };
    }
}

async function getOrderbookDepth(tokenId, priceLevel) {
    try {
        const client = getClient();
        const ob = await client.getOrderBook(tokenId);
        const bids = ob?.bids || [];
        let depth = 0;
        for (const b of bids) {
            if (parseFloat(b.price) >= priceLevel) {
                depth += parseFloat(b.size) || 0;
            }
        }
        return depth;
    } catch {
        return 0;
    }
}

async function getBestBid(tokenId) {
    try {
        const client = getClient();
        const ob = await client.getOrderBook(tokenId);
        const bids = ob?.bids || [];
        let best = 0;
        for (const b of bids) {
            const p = parseFloat(b.price);
            if (p > best) best = p;
        }
        return best > 0 ? best : null;
    } catch {
        return null;
    }
}

// ── Entry window: watch for breakout ──────────────────────────────────────────

async function watchForEntry(market) {
    const { yesTokenId, noTokenId, eventStartTime } = market;
    const threshold = config.momEntryThreshold;
    const pollMs = config.momEntryPollMs;
    const windowMs = config.momEntryWindow * 1000;
    const tag = market.asset ? `[${market.asset.toUpperCase()}]` : '';
    const sim = config.dryRun ? '[SIM]' : '';

    const asset = market.asset || 'btc';

    // Wait for market to actually open, updating countdown every second
    if (eventStartTime) {
        const openAt = new Date(eventStartTime).getTime();
        let remaining = openAt - Date.now();
        if (remaining > 0) {
            logger.info(`MOM${tag}: ${sim} waiting ${Math.round(remaining / 1000)}s for market to open...`);
            while (remaining > 0) {
                watchingMarkets.set(asset, { question: market.question, asset, yesPrice: 0, noPrice: 0, secsLeft: Math.round(remaining / 1000), status: 'waiting_open' });
                await sleep(Math.min(1000, remaining));
                remaining = openAt - Date.now();
            }
        }
    }

    const deadline = Date.now() + windowMs;

    // Show initial market pricing before entry window starts
    const initPrices = await getMidpoints(yesTokenId, noTokenId);
    logger.info(`MOM${tag}: ${sim} market prices — YES: $${initPrices.yes.toFixed(3)} | NO: $${initPrices.no.toFixed(3)}`);
    logger.info(`MOM${tag}: ${sim} watching for breakout above $${threshold} (${config.momEntryWindow}s window)`);

    watchingMarkets.set(asset, { question: market.question, asset, yesPrice: initPrices.yes, noPrice: initPrices.no, secsLeft: config.momEntryWindow, status: 'watching' });

    while (Date.now() < deadline) {
        const prices = await getMidpoints(yesTokenId, noTokenId);
        const secsLeft = Math.max(0, Math.round((deadline - Date.now()) / 1000));
        logger.watch(`MOM${tag}: ${sim} Y: $${prices.yes.toFixed(3)} | N: $${prices.no.toFixed(3)} | ${secsLeft}s left`);

        watchingMarkets.set(asset, { question: market.question, asset, yesPrice: prices.yes, noPrice: prices.no, secsLeft, status: 'watching' });

        if (prices.yes >= threshold || prices.no >= threshold) {
            const side = prices.yes >= prices.no ? 'yes' : 'no';
            const price = side === 'yes' ? prices.yes : prices.no;
            const tokenId = side === 'yes' ? yesTokenId : noTokenId;

            // Depth check
            if (config.momMinDepth > 0) {
                const depth = await getOrderbookDepth(tokenId, threshold * 0.95);
                if (depth < config.momMinDepth) {
                    logger.warn(`MOM${tag}: ${side.toUpperCase()} @ $${price.toFixed(3)} but depth ${depth.toFixed(1)} < min ${config.momMinDepth} — skipping`);
                    await sleep(pollMs);
                    continue;
                }
            }

            watchingMarkets.delete(asset);
            logger.success(`MOM${tag}: ${sim} breakout! ${side.toUpperCase()} @ $${price.toFixed(3)} > $${threshold}`);
            return { side, price, tokenId };
        }

        await sleep(pollMs);
    }

    watchingMarkets.delete(asset);
    logger.info(`MOM${tag}: no breakout within ${config.momEntryWindow}s — passing`);
    return null;
}

// ── Hold & monitor loop ───────────────────────────────────────────────────────

async function monitorPosition(pos) {
    const tag = pos.asset ? `[${pos.asset.toUpperCase()}]` : '';
    const sim = config.dryRun ? '[SIM]' : '';
    const label = pos.question.substring(0, 40);

    let highBid = pos.entryPrice;
    const exitTarget = config.momExitTarget;
    const trailEnabled = config.momTrailEnabled;
    const trailDropPct = config.momTrailDropPct;

    while (true) {
        const msRemaining = new Date(pos.endTime).getTime() - Date.now();

        if (msRemaining <= 0) {
            pos.status = 'expired';
            logger.warn(`MOM${tag}: market expired — ${label}`);
            break;
        }

        // Check current price via midpoint
        let currentPrice = pos.entryPrice;
        try {
            const client = getClient();
            const mp = await client.getMidpoint(pos.tokenId);
            currentPrice = parseFloat(mp?.mid ?? mp ?? '0') || pos.entryPrice;
        } catch { /* use last known */ }

        // Target hit — market sell when price reaches exit target
        if (currentPrice >= exitTarget) {
            logger.info(`MOM${tag}: ${sim} target reached $${currentPrice.toFixed(3)} ≥ $${exitTarget} — market selling`);
            const sellShares = config.dryRun ? pos.shares : ((await getTokenBalance(pos.tokenId)) ?? pos.shares);
            const result = await marketSell(pos.tokenId, sellShares, pos.tickSize, pos.negRisk);
            pos.exitPrice = result.fillPrice;
            pos.proceeds = result.proceeds;
            pos.status = 'done';
            pos.exitType = 'target_hit';
            const cost = pos.entryPrice * pos.shares;
            const pnl = result.proceeds - cost;
            logger.money(`MOM${tag}: ${sim} TARGET HIT! ${pos.side.toUpperCase()} sold @ $${pos.exitPrice.toFixed(3)} | proceeds $${result.proceeds.toFixed(2)} | P&L $${pnl.toFixed(2)}`);
            if (config.dryRun) {
                recordEvent({ type: 'mom_target_sell', amount: result.proceeds, pnl, market: label, side: pos.side.toUpperCase(), shares: pos.shares, price: pos.exitPrice });
                recordOrder({ market: label, side: pos.side.toUpperCase(), orderType: 'market_sell', price: pos.exitPrice, shares: pos.shares, status: 'filled', pnl });
            }
            break;
        }

        // Trailing stop
        if (trailEnabled) {
            const bid = await getBestBid(pos.tokenId);
            if (bid != null) {
                if (bid > highBid) highBid = bid;
                const threshold = highBid * (1 - trailDropPct);
                if (highBid > pos.entryPrice && bid < threshold) {
                    logger.info(`MOM${tag}: ${sim} trail stop — bid $${bid.toFixed(3)} < high $${highBid.toFixed(3)} * ${(1 - trailDropPct).toFixed(2)}`);

                    const sellShares = config.dryRun ? pos.shares : ((await getTokenBalance(pos.tokenId)) ?? pos.shares);
                    const result = await marketSell(pos.tokenId, sellShares, pos.tickSize, pos.negRisk);
                    pos.exitPrice = result.fillPrice;
                    pos.proceeds = result.proceeds;
                    pos.status = 'done';
                    pos.exitType = 'trail_stop';
                    const cost = pos.entryPrice * pos.shares;
                    const pnl = result.proceeds - cost;
                    logger.money(`MOM${tag}: ${sim} trail sold @ $${pos.exitPrice.toFixed(3)} | proceeds $${result.proceeds.toFixed(2)} | P&L $${pnl.toFixed(2)}`);
                    if (config.dryRun) {
                        recordEvent({ type: 'mom_trail_sell', amount: result.proceeds, pnl, market: label, side: pos.side.toUpperCase(), shares: pos.shares, price: pos.exitPrice });
                        recordOrder({ market: label, side: pos.side.toUpperCase(), orderType: 'market_sell', price: pos.exitPrice, shares: pos.shares, status: 'filled', pnl });
                    }
                    break;
                }
            }
        }

        // Cut-loss before expiry
        if (msRemaining <= config.momCutLossTime * 1000) {
            logger.warn(`MOM${tag}: ${sim} cut-loss triggered (${Math.round(msRemaining / 1000)}s left)`);

            const sellShares = config.dryRun ? pos.shares : ((await getTokenBalance(pos.tokenId)) ?? pos.shares);
            const result = await marketSell(pos.tokenId, sellShares, pos.tickSize, pos.negRisk);
            pos.exitPrice = result.fillPrice;
            pos.proceeds = result.proceeds;
            pos.status = 'done';
            pos.exitType = 'cut_loss';
            const cost = pos.entryPrice * pos.shares;
            const pnl = result.proceeds - cost;
            logger.warn(`MOM${tag}: ${sim} cut @ $${pos.exitPrice.toFixed(3)} | proceeds $${result.proceeds.toFixed(2)} | P&L $${pnl.toFixed(2)}`);
            if (config.dryRun) {
                recordEvent({ type: 'mom_cut_loss', amount: result.proceeds, pnl, market: label, side: pos.side.toUpperCase(), shares: sellShares, price: pos.exitPrice });
                recordOrder({ market: label, side: pos.side.toUpperCase(), orderType: 'market_sell', price: pos.exitPrice, shares: sellShares, status: 'filled', pnl });
            }
            break;
        }

        await sleep(config.momEntryPollMs);
    }

    // Final P&L
    const cost = pos.entryPrice * pos.shares;
    const totalPnl = pos.proceeds ? pos.proceeds - cost : (pos.exitPrice ? (pos.exitPrice - pos.entryPrice) * pos.shares : 0);
    const sign = totalPnl >= 0 ? '+' : '';
    if (pos.status !== 'done') {
        logger.info(`MOM${tag}: strategy ended (${pos.status}) | P&L: ${sign}$${totalPnl.toFixed(2)} | ${label}`);
    }
}

// ── Main entry point ──────────────────────────────────────────────────────────

export async function executeMomentumStrategy(market) {
    const { asset, conditionId, question, endTime, yesTokenId, noTokenId, negRisk, tickSize } = market;
    const tag = asset ? `[${asset.toUpperCase()}]` : '';
    const sim = config.dryRun ? '[SIM] ' : '';
    const label = question.substring(0, 40);

    logger.info(`MOM${tag}: ${sim}entering — ${label}`);

    // Balance check
    const needed = config.momTradeSize;
    if (config.dryRun) {
        const simBal = getBalance();
        if (simBal < needed) {
            logger.error(`MOM${tag}: insufficient sim balance $${simBal.toFixed(2)} (need $${needed})`);
            return;
        }
    } else {
        const balance = await getUsdcBalance();
        if (balance < needed) {
            logger.error(`MOM${tag}: insufficient balance $${balance.toFixed(2)} (need $${needed})`);
            return;
        }
    }

    // Watch for breakout during entry window
    const entry = await watchForEntry(market);
    if (!entry) {
        if (config.dryRun) {
            recordEvent({ type: 'mom_no_entry', amount: 0, market: label, description: 'no breakout within entry window' });
        }
        return;
    }

    // Execute market buy
    const { side, price: signalPrice, tokenId } = entry;
    logger.trade(`MOM${tag}: ${sim}buying ${side.toUpperCase()} — $${needed} @ ~$${signalPrice.toFixed(3)}`);

    const buyResult = await marketBuy(tokenId, needed, tickSize, negRisk);
    if (!buyResult.success) {
        logger.error(`MOM${tag}: buy failed — aborting`);
        return;
    }

    const entryPrice = buyResult.fillPrice;
    const shares = buyResult.shares;
    logger.money(`MOM${tag}: ${sim}bought ${shares.toFixed(3)} ${side.toUpperCase()} @ $${entryPrice.toFixed(3)}`);

    if (config.dryRun) {
        recordEvent({ type: 'mom_buy', amount: -needed, market: label, side: side.toUpperCase(), shares, price: entryPrice });
        recordOrder({ market: label, side: side.toUpperCase(), orderType: 'market_buy', price: entryPrice, shares, status: 'filled' });
    }

    logger.info(`MOM${tag}: ${sim}holding — will market sell at $${config.momExitTarget} or trail/cut-loss`);

    // Build position object
    const eventStart = market.eventStartTime ? new Date(market.eventStartTime).getTime() : null;
    const enteredAtMs = Date.now();
    const entrySecFromOpen = eventStart ? Math.round((enteredAtMs - eventStart) / 1000) : null;

    const pos = {
        asset: asset || 'btc',
        conditionId,
        question,
        endTime,
        tickSize,
        negRisk,
        status: 'holding',
        enteredAt: new Date(enteredAtMs).toISOString(),
        entrySecFromOpen,
        side,
        tokenId,
        entryPrice,
        shares,
        exitPrice: null,
        exitType: null,
    };

    activePositions.set(conditionId, pos);

    if (config.dryRun) {
        recordPosition({
            market: label, conditionId, entryCost: needed,
            side: side.toUpperCase(), shares, entryPrice,
            status: 'open', strategy: 'momentum',
        });
    }

    // Monitor until exit
    await monitorPosition(pos);

    // Record close
    if (config.dryRun) {
        const cost = pos.entryPrice * pos.shares;
        const totalPnl = pos.proceeds ? pos.proceeds - cost : (pos.exitPrice ? (pos.exitPrice - pos.entryPrice) * pos.shares : 0);
        recordPosition({
            market: label, conditionId, entryCost: needed,
            side: side.toUpperCase(), shares, entryPrice,
            exitPrice: pos.exitPrice, exitType: pos.exitType,
            status: 'closed', pnl: totalPnl, endTime: pos.endTime,
            strategy: 'momentum',
        });
    }

    activePositions.delete(conditionId);
}
