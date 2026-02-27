/**
 * mmExecutor.js
 * Executes the market-maker strategy for a single Bitcoin 5-minute market:
 *   1. Call CTF splitPosition — deposit USDC, receive equal YES+NO tokens at $0.50 flat
 *   2. Place GTC limit sells at mmSellPrice for both YES and NO
 *   3. Monitor until both fills or cut-loss time triggers
 *   4. On cut-loss:
 *        - If NEITHER side filled  → mergePositions (burn YES+NO, recover USDC, zero loss)
 *        - If ONE side already sold → cancel the other, market-sell remaining tokens
 */

import { Side, OrderType } from '@polymarket/clob-client';
import { ethers } from 'ethers';
import config from '../config/index.js';
import { getClient, getUsdcBalance, getPolygonProvider } from './client.js';
import { splitPosition, mergePositions } from './ctf.js';
import logger from '../utils/logger.js';
import { recordEvent, recordOrder, recordPosition, getBalance } from '../utils/mmSimSession.js';

// CTF contract for on-chain balance queries
const CTF_ADDRESS = '0x4D97DCd97eC945f40cF65F87097ACe5EA0476045';
const CTF_BALANCE_ABI = ['function balanceOf(address account, uint256 id) view returns (uint256)'];

/**
 * Get actual on-chain ERC1155 token balance for the proxy wallet.
 * Used before market-sell to avoid 'not enough balance' errors from partial fills.
 */
async function getTokenBalance(tokenId) {
    try {
        const provider = await getPolygonProvider();
        const ctf = new ethers.Contract(CTF_ADDRESS, CTF_BALANCE_ABI, provider);
        const raw = await ctf.balanceOf(config.proxyWallet, tokenId);
        return parseFloat(ethers.utils.formatUnits(raw, 6));
    } catch {
        return null; // fallback: caller will use pos.shares
    }
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// In-memory store of all active MM positions (conditionId → position)
const activePositions = new Map();

export function getActiveMMPositions() {
    return Array.from(activePositions.values());
}

/** Wait for monitorAndManage to return and positions to be removed (for sim exit). */
export async function waitForActivePositionsToClose(maxMs = 20_000) {
    const deadline = Date.now() + maxMs;
    while (activePositions.size > 0 && Date.now() < deadline) {
        await sleep(500);
    }
}

// ── Order helpers ─────────────────────────────────────────────────────────────

async function placeLimitSell(tokenId, shares, price, tickSize, negRisk) {
    if (config.dryRun) {
        return { success: true, orderId: `sim-${Date.now()}-${tokenId.slice(-6)}` };
    }

    const client = getClient();
    try {
        const res = await client.createAndPostOrder(
            { tokenID: tokenId, side: Side.SELL, price, size: shares },
            { tickSize, negRisk },
            OrderType.GTC,
        );
        if (!res?.success) return { success: false };
        return { success: true, orderId: res.orderID };
    } catch (err) {
        logger.error('MM limit sell error:', err.message);
        return { success: false };
    }
}

async function cancelOrder(orderId) {
    if (config.dryRun || !orderId || orderId.startsWith('sim-')) return true;
    try {
        const client = getClient();
        await client.cancelOrder({ orderID: orderId }); // SDK expects { orderID } object
        return true;
    } catch (err) {
        logger.warn('MM cancel order error:', err.message);
        return false;
    }
}

async function marketSell(tokenId, shares, tickSize, negRisk) {
    if (config.dryRun) {
        // Fetch real midpoint for realistic sim instead of using limit sell price
        try {
            const client = getClient();
            const mp = await client.getMidpoint(tokenId);
            const realPrice = parseFloat(mp?.mid ?? mp ?? '0') || config.mmSellPrice;
            return { success: true, fillPrice: Math.min(realPrice, config.mmSellPrice) };
        } catch {
            return { success: true, fillPrice: config.mmSellPrice * 0.8 }; // fallback: 80% of sell price
        }
    }

    const client = getClient();
    try {
        const res = await client.createAndPostMarketOrder(
            { tokenID: tokenId, side: Side.SELL, amount: shares, price: 0.01 },
            { tickSize, negRisk },
            OrderType.FOK,
        );
        if (!res?.success) return { success: false, fillPrice: 0 };
        return { success: true, fillPrice: parseFloat(res.price || '0') };
    } catch (err) {
        logger.error('MM market sell error:', err.message);
        return { success: false, fillPrice: 0 };
    }
}

// ── Order status check ────────────────────────────────────────────────────────

async function isOrderFilled(orderId, shares) {
    if (!orderId || orderId.startsWith('sim-')) return false;
    try {
        const client = getClient();
        const order = await client.getOrder(orderId);
        if (!order) return false;
        if (order.status === 'MATCHED') return true;
        const matched = parseFloat(order.size_matched || '0');
        return matched >= shares * 0.99;
    } catch {
        return false;
    }
}

// For simulation: check if market price has reached the sell target
async function simPriceHitTarget(tokenId) {
    try {
        const client = getClient();
        const mp = await client.getMidpoint(tokenId);
        const price = parseFloat(mp?.mid ?? mp ?? '0');
        return price >= config.mmSellPrice ? price : null;
    } catch {
        return null;
    }
}

// Get best bid from orderbook (for momentum trail)
async function getBestBid(tokenId) {
    try {
        const client = getClient();
        const ob = await client.getOrderBook(tokenId);
        const bids = ob?.bids || [];
        if (bids.length === 0) return null;
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

// Check if momentum is one-sided: filled side's price trending up over lookback
function isMomentumOneSided(priceHistory, lookback) {
    if (!priceHistory || priceHistory.length < lookback + 1) return false;
    const first = priceHistory[priceHistory.length - 1 - lookback];
    const last = priceHistory[priceHistory.length - 1];
    return last > first;
}

// ── Core monitoring loop ──────────────────────────────────────────────────────

async function monitorAndManage(pos) {
    const label = pos.question.substring(0, 40);

    while (true) {
        const msRemaining = new Date(pos.endTime).getTime() - Date.now();

        if (msRemaining <= 0) {
            logger.warn(`MM: market expired — ${label}`);
            pos.status = 'expired';
            break;
        }

        // ── Price history (for momentum check) ──────────────────
        if (pos._priceHistory) {
            try {
                const client = getClient();
                const [yesMp, noMp] = await Promise.all([
                    client.getMidpoint(pos.yes.tokenId),
                    client.getMidpoint(pos.no.tokenId),
                ]);
                const yesP = parseFloat(yesMp?.mid ?? yesMp ?? '0') || 0;
                const noP = parseFloat(noMp?.mid ?? noMp ?? '0') || 0;
                pos._priceHistory.yes.push(yesP);
                pos._priceHistory.no.push(noP);
                const maxLen = 10;
                if (pos._priceHistory.yes.length > maxLen) pos._priceHistory.yes.shift();
                if (pos._priceHistory.no.length > maxLen) pos._priceHistory.no.shift();
            } catch { /* ignore */ }
        }

        // ── Momentum trail: sell unfilled when bid drops from high ──
        if (pos._momentumTrail) {
            const side = pos._momentumUnfilledSide;
            const tokenId = pos[side].tokenId;
            const bid = await getBestBid(tokenId);
            if (bid != null) {
                if (bid > pos._trailHighBid) pos._trailHighBid = bid;
                const threshold = pos._trailHighBid * (1 - config.mmTrailDropPct);
                if (pos._trailHighBid > 0 && bid < threshold) {
                    logger.info(`MM${config.dryRun ? '[SIM]' : ''}: momentum trail — ${side.toUpperCase()} bid $${bid.toFixed(3)} < high*${(1 - config.mmTrailDropPct).toFixed(2)} → selling`);
                    await cancelOrder(pos[side].orderId);
                    const result = await marketSell(tokenId, pos[side].shares, pos.tickSize, pos.negRisk);
                    pos[side].fillPrice = result.fillPrice;
                    pos[side].filled = true;
                    const pnl = (pos[side].fillPrice - pos[side].entryPrice) * pos[side].shares;
                    logger.money(`MM${config.dryRun ? '[SIM]' : ''}: ${side.toUpperCase()} momentum trail sold @ $${pos[side].fillPrice.toFixed(3)} | P&L $${pnl.toFixed(2)}`);
                    if (config.dryRun) {
                        recordEvent({ type: 'momentum_trail_sell', amount: result.fillPrice * pos[side].shares, pnl, market: label, side: side.toUpperCase(), shares: pos[side].shares, price: result.fillPrice });
                    }
                    pos.status = 'done';
                    pos._exitType = 'momentum_trail';
                    break;
                }
            }
            if (msRemaining <= config.mmCutLossTime * 1000) {
                logger.warn(`MM: momentum trail cut-loss — ${side.toUpperCase()} selling at deadline`);
                await cancelOrder(pos[side].orderId);
                const result = await marketSell(tokenId, pos[side].shares, pos.tickSize, pos.negRisk);
                pos[side].fillPrice = result.fillPrice;
                pos[side].filled = true;
                const pnl = (pos[side].fillPrice - pos[side].entryPrice) * pos[side].shares;
                logger.warn(`MM: ${side.toUpperCase()} sold @ $${pos[side].fillPrice.toFixed(3)} | P&L $${pnl.toFixed(2)}`);
                if (config.dryRun) recordEvent({ type: 'momentum_trail_cut', amount: result.fillPrice * pos[side].shares, pnl, market: label, side: side.toUpperCase() });
                pos.status = 'done';
                pos._exitType = 'momentum_trail';
                break;
            }
            await sleep(config.mmPollInterval || 10_000);
            continue;
        }

        // ── Check YES side ──────────────────────────────────────
        if (!pos.yes.filled) {
            let filled = false;
            if (config.dryRun) {
                const hitPrice = await simPriceHitTarget(pos.yes.tokenId);
                if (hitPrice) { filled = true; pos.yes.fillPrice = config.mmSellPrice; }
            } else {
                filled = await isOrderFilled(pos.yes.orderId, pos.yes.shares);
                if (filled) pos.yes.fillPrice = config.mmSellPrice;
            }
            if (filled) {
                pos.yes.filled = true;
                pos.yes.filledAt = Date.now();
                const pnl = (pos.yes.fillPrice - pos.yes.entryPrice) * pos.yes.shares;
                logger.money(`MM${config.dryRun ? '[SIM]' : ''}: YES filled @ $${pos.yes.fillPrice.toFixed(3)} | P&L $${pnl.toFixed(2)}`);
                if (config.dryRun) {
                    // Capture real midpoint/spread at fill time (getMidpoint returns actual trading mid, not orderbook mid)
                    let midAtFill = null, spreadAtFill = null, otherMidAtFill = null;
                    try {
                        const client = getClient();
                        const [mp, sp, otherMp] = await Promise.all([
                            client.getMidpoint(pos.yes.tokenId),
                            client.getSpread(pos.yes.tokenId),
                            client.getMidpoint(pos.no.tokenId),
                        ]);
                        midAtFill = parseFloat(mp?.mid ?? mp ?? '0') || null;
                        spreadAtFill = parseFloat(sp?.spread ?? sp ?? '0') || null;
                        otherMidAtFill = parseFloat(otherMp?.mid ?? otherMp ?? '0') || null;
                    } catch { /* ignore */ }
                    const proceeds = pos.yes.fillPrice * pos.yes.shares;
                    recordEvent({ type: 'fill_yes', amount: proceeds, pnl, market: label, side: 'YES', shares: pos.yes.shares, price: pos.yes.fillPrice });
                    recordOrder({ market: label, side: 'YES', orderType: 'limit_sell', price: pos.yes.fillPrice, shares: pos.yes.shares, status: 'filled', pnl,
                        midpointAtFill: midAtFill, spreadAtFill, otherSideMidAtFill: otherMidAtFill });
                }
            }
        }

        // ── Check NO side ───────────────────────────────────────
        if (!pos.no.filled) {
            let filled = false;
            if (config.dryRun) {
                const hitPrice = await simPriceHitTarget(pos.no.tokenId);
                if (hitPrice) { filled = true; pos.no.fillPrice = config.mmSellPrice; }
            } else {
                filled = await isOrderFilled(pos.no.orderId, pos.no.shares);
                if (filled) pos.no.fillPrice = config.mmSellPrice;
            }
            if (filled) {
                pos.no.filled = true;
                pos.no.filledAt = Date.now();
                const pnl = (pos.no.fillPrice - pos.no.entryPrice) * pos.no.shares;
                logger.money(`MM${config.dryRun ? '[SIM]' : ''}: NO  filled @ $${pos.no.fillPrice.toFixed(3)} | P&L $${pnl.toFixed(2)}`);
                if (config.dryRun) {
                    let midAtFill = null, spreadAtFill = null, otherMidAtFill = null;
                    try {
                        const client = getClient();
                        const [mp, sp, otherMp] = await Promise.all([
                            client.getMidpoint(pos.no.tokenId),
                            client.getSpread(pos.no.tokenId),
                            client.getMidpoint(pos.yes.tokenId),
                        ]);
                        midAtFill = parseFloat(mp?.mid ?? mp ?? '0') || null;
                        spreadAtFill = parseFloat(sp?.spread ?? sp ?? '0') || null;
                        otherMidAtFill = parseFloat(otherMp?.mid ?? otherMp ?? '0') || null;
                    } catch { /* ignore */ }
                    const proceeds = pos.no.fillPrice * pos.no.shares;
                    recordEvent({ type: 'fill_no', amount: proceeds, pnl, market: label, side: 'NO', shares: pos.no.shares, price: pos.no.fillPrice });
                    recordOrder({ market: label, side: 'NO', orderType: 'limit_sell', price: pos.no.fillPrice, shares: pos.no.shares, status: 'filled', pnl,
                        midpointAtFill: midAtFill, spreadAtFill, otherSideMidAtFill: otherMidAtFill });
                }
            }
        }

        // ── Both filled → done ──────────────────────────────────
        if (pos.yes.filled && pos.no.filled) {
            pos.status = 'done';
            const totalPnl = calcPnl(pos);
            logger.money(`MM: BOTH sides filled! Total P&L: $${totalPnl.toFixed(2)} | ${label}`);
            break;
        }

        // ── One filled + momentum: cancel other, trail or add ─────
        const oneFilled = (pos.yes.filled && !pos.no.filled) || (!pos.yes.filled && pos.no.filled);
        if (config.mmMomentum && oneFilled && pos._priceHistory && !pos._momentumTrail && !pos._momentumAdd) {
            const yesFilled = pos.yes.filled;
            const history = yesFilled ? pos._priceHistory.yes : pos._priceHistory.no;
            const lookback = config.mmMomentumLookback || 3;
            if (isMomentumOneSided(history, lookback)) {
                const momDir = yesFilled ? 'YES' : 'NO';
                const unfilledSide = yesFilled ? 'no' : 'yes';
                logger.info(`MM${config.dryRun ? '[SIM]' : ''}: momentum confirmed (mom=${momDir}) — cancelling ${unfilledSide.toUpperCase()} limit`);
                await cancelOrder(pos[unfilledSide].orderId);

                if (config.mmMomentumMode === 'add') {
                    const tokenId = pos[momDir.toLowerCase()].tokenId;
                    const addSize = config.mmTradeSize;
                    logger.trade(`MM${config.dryRun ? '[SIM]' : ''}: momentum add — buying ${momDir} @ market`);
                    try {
                        const mp = await getClient().getMidpoint(tokenId);
                        const price = parseFloat(mp?.mid ?? mp ?? '0.60') || 0.60;
                        if (config.dryRun) {
                            pos._momentumAddShares = addSize / price;
                            pos._momentumAddEntry = price;
                            recordEvent({ type: 'momentum_add_buy', amount: -addSize, description: `add ${momDir}`, market: label, side: momDir, shares: pos._momentumAddShares, price });
                        } else {
                            const res = await getClient().createAndPostMarketOrder(
                                { tokenID: tokenId, side: Side.BUY, amount: addSize, price: 0.99 },
                                { tickSize: pos.tickSize, negRisk: pos.negRisk },
                                OrderType.FOK,
                            );
                            if (res?.success) {
                                pos._momentumAddShares = parseFloat(res.takingAmount || addSize / price);
                                pos._momentumAddEntry = parseFloat(res.price || String(price));
                                logger.money(`MM: momentum add filled ${pos._momentumAddShares.toFixed(3)} ${momDir} @ $${pos._momentumAddEntry.toFixed(3)}`);
                            } else {
                                pos._momentumAddShares = 0;
                            }
                        }
                    } catch {
                        pos._momentumAddShares = 0;
                    }
                    pos._momentumAdd = true;
                    pos._momentumAddSide = momDir;
                } else {
                    pos._momentumTrail = true;
                    pos._momentumUnfilledSide = unfilledSide;
                    pos._trailHighBid = 0;
                }
            }
        }

        // ── Momentum add: monitor for add target or cut-loss ───────
        if (pos._momentumAdd && (!pos._momentumAddShares || pos._momentumAddShares <= 0)) {
            const unfilledSide = pos._momentumAddSide === 'YES' ? 'no' : 'yes';
            logger.warn(`MM: momentum add failed — selling ${unfilledSide.toUpperCase()}`);
            await cancelOrder(pos[unfilledSide].orderId);
            const result = await marketSell(pos[unfilledSide].tokenId, pos[unfilledSide].shares, pos.tickSize, pos.negRisk);
            pos[unfilledSide].fillPrice = result.fillPrice;
            pos[unfilledSide].filled = true;
            pos.status = 'done';
            pos._exitType = 'momentum_add';
            pos._momentumAdd = false;
            break;
        }
        if (pos._momentumAdd && pos._momentumAddShares > 0) {
            const side = pos._momentumAddSide.toLowerCase();
            const tokenId = pos[side].tokenId;
            const target = config.mmAddTarget || 0.70;
            try {
                const mp = await getClient().getMidpoint(tokenId);
                const price = parseFloat(mp?.mid ?? mp ?? '0') || 0;
                if (price >= target) {
                    const addPnl = (target - pos._momentumAddEntry) * pos._momentumAddShares;
                    pos[side].fillPrice = (pos[side].fillPrice || config.mmSellPrice);
                    logger.money(`MM[SIM]: momentum add exit @ $${target.toFixed(2)} | add P&L $${addPnl.toFixed(2)}`);
                    recordEvent({ type: 'momentum_add_sell', amount: target * pos._momentumAddShares, pnl: addPnl, market: label, side: pos._momentumAddSide, shares: pos._momentumAddShares, price: target });
                    pos._momentumAddShares = 0;
                }
            } catch { /* ignore */ }
            if (msRemaining <= config.mmCutLossTime * 1000) {
                try {
                    const mp = await getClient().getMidpoint(tokenId);
                    const price = parseFloat(mp?.mid ?? mp ?? '0') || pos._momentumAddEntry;
                    const addPnl = (price - pos._momentumAddEntry) * pos._momentumAddShares;
                    logger.warn(`MM[SIM]: momentum add cut @ $${price.toFixed(3)} | add P&L $${addPnl.toFixed(2)}`);
                    recordEvent({ type: 'momentum_add_cut', amount: price * pos._momentumAddShares, pnl: addPnl, market: label, side: pos._momentumAddSide });
                } catch { /* ignore */ }
                pos._momentumAddShares = 0;
            }
            if (pos._momentumAddShares <= 0) {
                pos._momentumAdd = false;
                // Still need to sell the original unfilled side
                const unfilledSide = side === 'yes' ? 'no' : 'yes';
                if (!pos[unfilledSide].filled) {
                    logger.warn(`MM: momentum add done — market-selling ${unfilledSide.toUpperCase()}`);
                    await cancelOrder(pos[unfilledSide].orderId);
                    const result = await marketSell(pos[unfilledSide].tokenId, pos[unfilledSide].shares, pos.tickSize, pos.negRisk);
                    pos[unfilledSide].fillPrice = result.fillPrice;
                    pos[unfilledSide].filled = true;
                    pos.status = 'done';
                    pos._exitType = 'momentum_add';
                    break;
                }
            }
        }

        // ── Cut-loss time ───────────────────────────────────────
        if (msRemaining <= config.mmCutLossTime * 1000 && !pos._momentumTrail && !pos._momentumAdd) {
            logger.warn(`MM: cut-loss triggered (${Math.round(msRemaining / 1000)}s left) — ${label}`);
            pos.status = 'cutting';
            await cutLoss(pos);
            break;
        }

        await sleep(10_000);
    }

    // Final P&L log
    const totalPnl = calcPnl(pos);
    const sign = totalPnl >= 0 ? '+' : '';
    if (pos.status !== 'done') {
        logger.info(`MM: strategy ended (${pos.status}) | P&L: ${sign}$${totalPnl.toFixed(2)} | ${label}`);
    }
}

async function cutLoss(pos) {
    const { conditionId, tickSize, negRisk } = pos;
    const neitherFilled = !pos.yes.filled && !pos.no.filled;

    pos._wasCutLoss = true;

    if (neitherFilled) {
        pos._cutLossType = 'cut_loss_merge';
        // ── Best case: neither side sold → cancel both, merge back to USDC ──
        logger.warn('MM: neither side filled — cancelling orders and merging back to USDC...');
        await cancelOrder(pos.yes.orderId);
        await cancelOrder(pos.no.orderId);

        // Read actual on-chain balances (may differ from original if partially consumed)
        const [yesActual, noActual] = await Promise.all([
            getTokenBalance(pos.yes.tokenId),
            getTokenBalance(pos.no.tokenId),
        ]);

        // mergePositions needs equal amounts — use the minimum actual balance
        const yesShares = yesActual ?? pos.yes.shares;
        const noShares = noActual ?? pos.no.shares;
        const mergeAmt = Math.min(yesShares, noShares);

        if (mergeAmt < 0.001) {
            logger.warn('MM: balances too low to merge — nothing to recover');
        } else {
            const recovered = await mergePositions(conditionId, mergeAmt);
            logger.money(`MM: merge complete — recovered ~$${recovered.toFixed ? recovered.toFixed(2) : recovered} USDC (P&L ≈ $0)`);
            if (config.dryRun) {
                recordEvent({ type: 'merge', amount: recovered, description: `merge ${pos.question.substring(0, 40)}`, market: pos.question.substring(0, 40) });
            }
        }

        // Mark both sides closed at entry price
        pos.yes.fillPrice = pos.yes.entryPrice;
        pos.yes.filled = true;
        pos.no.fillPrice = pos.no.entryPrice;
        pos.no.filled = true;

    } else {
        pos._cutLossType = 'cut_loss_market_sell';
        // ── One side already (partly) sold → market-sell the unfilled side ──
        for (const side of ['yes', 'no']) {
            const s = pos[side];
            if (s.filled) continue;

            logger.warn(`MM: cancelling ${side.toUpperCase()} limit order and market-selling...`);
            await cancelOrder(s.orderId);

            // In dry-run, skip on-chain balance (no real split happened) — use original shares
            const actualShares = config.dryRun ? null : await getTokenBalance(s.tokenId);
            const sellShares = actualShares !== null ? actualShares : s.shares;

            if (sellShares < 0.001) {
                logger.warn(`MM: ${side.toUpperCase()} balance is 0 — already fully sold via partial fills`);
                s.fillPrice = config.mmSellPrice; // assume sold at target
                s.filled = true;
                continue;
            }

            logger.warn(`MM: ${side.toUpperCase()} actual balance: ${sellShares.toFixed(3)} shares (original: ${s.shares})`);

            const result = await marketSell(s.tokenId, sellShares, tickSize, negRisk);
            s.fillPrice = result.fillPrice;
            s.filled = true;
            // PnL uses actual sold amount (not original pos.shares)
            const pnl = (s.fillPrice - s.entryPrice) * sellShares;
            logger.warn(`MM: ${side.toUpperCase()} cut @ $${s.fillPrice.toFixed(3)} | sold ${sellShares.toFixed(3)} sh | P&L $${pnl.toFixed(2)}`);
            if (config.dryRun) {
                // Capture midpoints at cut-loss sell time
                let midAtCut = null, spreadAtCut = null, otherMidAtCut = null;
                try {
                    const client = getClient();
                    const otherSide = side === 'yes' ? 'no' : 'yes';
                    const [mp, sp, otherMp] = await Promise.all([
                        client.getMidpoint(s.tokenId),
                        client.getSpread(s.tokenId),
                        client.getMidpoint(pos[otherSide].tokenId),
                    ]);
                    midAtCut = parseFloat(mp?.mid ?? mp ?? '0') || null;
                    spreadAtCut = parseFloat(sp?.spread ?? sp ?? '0') || null;
                    otherMidAtCut = parseFloat(otherMp?.mid ?? otherMp ?? '0') || null;
                } catch { /* ignore */ }
                const proceeds = result.fillPrice * sellShares;
                recordEvent({ type: 'cut_loss_sell', amount: proceeds, pnl, market: pos.question.substring(0, 40), side: side.toUpperCase(), shares: sellShares, price: result.fillPrice });
                recordOrder({ market: pos.question.substring(0, 40), side: side.toUpperCase(), orderType: 'market_sell', price: result.fillPrice, shares: sellShares, status: 'filled', pnl,
                    midpointAtFill: midAtCut, spreadAtFill: spreadAtCut, otherSideMidAtFill: otherMidAtCut });
            }
        }
    }

    pos.status = 'done';

    // Optional recovery buy (enabled via MM_RECOVERY_BUY=true)
    await attemptRecoveryBuy(pos);
}

// ── Recovery buy ──────────────────────────────────────────────────────────────

/**
 * After a cut-loss, optionally take a directional bet on the dominant side.
 *
 * Criteria (all must pass):
 *   1. MM_RECOVERY_BUY=true in .env
 *   2. One side's price is above MM_RECOVERY_THRESHOLD (default 70%)
 *   3. That price is stable or rising over a 10-second sample (1 fetch/second)
 *   4. Wallet balance is sufficient for the recovery size
 */
async function attemptRecoveryBuy(pos) {
    if (!config.mmRecoveryBuy) return;

    const { tickSize, negRisk } = pos;
    const label = pos.question.substring(0, 40);
    const recoverySize = config.mmRecoverySize > 0 ? config.mmRecoverySize : config.mmTradeSize;
    const client = getClient();

    logger.info(`MM recovery: monitoring prices for 10s | ${label}`);

    // ── Sample both sides once per second for 10 seconds ─────────
    const samples = { yes: [], no: [] };

    for (let i = 0; i < 10; i++) {
        for (const [key, tokenId] of [['yes', pos.yes.tokenId], ['no', pos.no.tokenId]]) {
            try {
                const mp    = await client.getMidpoint(tokenId);
                const price = parseFloat(mp?.mid ?? mp ?? '0') || 0;
                samples[key].push(price);
            } catch { /* skip */ }
        }
        if (i < 9) await sleep(1000);
    }

    // ── Determine eligible side ───────────────────────────────────
    // Need: last price ≥ threshold AND last price ≥ first price (not declining)
    let candidate = null;
    for (const [key, tokenId] of [['yes', pos.yes.tokenId], ['no', pos.no.tokenId]]) {
        const arr = samples[key];
        if (arr.length < 2) continue;

        const firstPrice = arr[0];
        const lastPrice  = arr[arr.length - 1];

        if (lastPrice >= config.mmRecoveryThreshold && lastPrice >= firstPrice) {
            candidate = { side: key.toUpperCase(), tokenId, price: lastPrice };
            break;
        }
    }

    if (!candidate) {
        logger.info(`MM recovery: no eligible side — need price ≥ ${config.mmRecoveryThreshold} and rising/stable`);
        return;
    }

    // ── Balance check ─────────────────────────────────────────────
    if (!config.dryRun) {
        const balance = await getUsdcBalance();
        if (balance < recoverySize) {
            logger.warn(`MM recovery: insufficient balance $${balance.toFixed(2)} < $${recoverySize} needed`);
            return;
        }
    }

    logger.trade(`MM recovery${config.dryRun ? '[SIM]' : ''}: buying ${candidate.side} @ $${candidate.price.toFixed(3)} | size $${recoverySize}`);

    // ── Market buy ────────────────────────────────────────────────
    let entryPrice = candidate.price;
    let filledShares = recoverySize / entryPrice; // default estimate

    if (config.dryRun) {
        logger.money(`MM recovery[SIM]: bought ${filledShares.toFixed(3)} ${candidate.side} @ $${entryPrice.toFixed(3)}`);
        recordEvent({ type: 'recovery_buy', amount: -recoverySize, description: `recovery buy ${candidate.side}`, market: label, side: candidate.side, shares: filledShares, price: entryPrice });
    } else {
        try {
            const res = await client.createAndPostMarketOrder(
                { tokenID: candidate.tokenId, side: Side.BUY, amount: recoverySize, price: 0.99 },
                { tickSize, negRisk },
                OrderType.FOK,
            );
            if (!res?.success) {
                logger.warn(`MM recovery: order not filled — ${res?.errorMsg || 'no fill'}`);
                return;
            }
            entryPrice   = parseFloat(res.price || String(candidate.price));
            filledShares = parseFloat(res.takingAmount || String(recoverySize / entryPrice));
            logger.money(`MM recovery: FILLED ${candidate.side} ${filledShares.toFixed(3)} sh @ $${entryPrice.toFixed(3)} | potential payout $${filledShares.toFixed(2)}`);
        } catch (err) {
            logger.error(`MM recovery: buy error — ${err.message}`);
            return;
        }
    }

    // ── Monitor for 30s — cut loss if price worsens ───────────────
    logger.info(`MM recovery: holding ${candidate.side} — will cut if price < $${entryPrice.toFixed(3)} after 30s`);
    await sleep(30_000);

    // Skip second CL if market is already closed or about to close (< 5s left)
    const msLeft = new Date(pos.endTime).getTime() - Date.now();
    if (msLeft < 5_000) {
        logger.info(`MM recovery: market closing — skipping 2nd CL, letting position resolve`);
        return;
    }

    // Check current price
    let currentPrice = entryPrice;
    try {
        const mp   = await client.getMidpoint(candidate.tokenId);
        currentPrice = parseFloat(mp?.mid ?? mp ?? String(entryPrice)) || entryPrice;
    } catch { /* use entryPrice as fallback */ }

    if (currentPrice >= entryPrice) {
        logger.success(`MM recovery: price holding $${currentPrice.toFixed(3)} ≥ entry $${entryPrice.toFixed(3)} — keeping position`);
        return;
    }

    // Price has worsened — cut loss
    const priceDrop = ((entryPrice - currentPrice) / entryPrice * 100).toFixed(1);
    logger.warn(`MM recovery: price dropped $${entryPrice.toFixed(3)} → $${currentPrice.toFixed(3)} (-${priceDrop}%) — cutting loss`);

    if (config.dryRun) {
        const simPnl = (currentPrice - entryPrice) * filledShares;
        logger.warn(`MM recovery[SIM]: 2nd CL @ $${currentPrice.toFixed(3)} | P&L $${simPnl.toFixed(2)}`);
        const proceeds = currentPrice * filledShares;
        recordEvent({ type: 'recovery_sell', amount: proceeds, pnl: simPnl, market: label, side: candidate.side, shares: filledShares, price: currentPrice });
        recordOrder({ market: label, side: candidate.side, orderType: 'market_sell', price: currentPrice, shares: filledShares, status: 'filled', pnl: simPnl });
        return;
    }

    try {
        const sellRes = await client.createAndPostMarketOrder(
            { tokenID: candidate.tokenId, side: Side.SELL, amount: filledShares, price: 0.01 },
            { tickSize, negRisk },
            OrderType.FOK,
        );
        if (sellRes?.success) {
            const sellPrice = parseFloat(sellRes.price || String(currentPrice));
            const pnl = (sellPrice - entryPrice) * filledShares;
            logger.warn(`MM recovery: 2nd CL sold @ $${sellPrice.toFixed(3)} | P&L $${pnl.toFixed(2)}`);
        } else {
            logger.warn(`MM recovery: 2nd CL sell failed — ${sellRes?.errorMsg || 'no fill'} — position will resolve at close`);
        }
    } catch (err) {
        logger.error(`MM recovery: 2nd CL sell error — ${err.message}`);
    }
}

function calcPnl(pos) {
    const yesPnl = pos.yes.filled
        ? (pos.yes.fillPrice - pos.yes.entryPrice) * pos.yes.shares
        : 0;
    const noPnl = pos.no.filled
        ? (pos.no.fillPrice - pos.no.entryPrice) * pos.no.shares
        : 0;
    return yesPnl + noPnl;
}

// ── Main entry point ──────────────────────────────────────────────────────────

export async function executeMMStrategy(market) {
    const { asset, conditionId, question, endTime, yesTokenId, noTokenId, negRisk, tickSize } = market;
    const tag   = asset ? `[${asset.toUpperCase()}]` : '';
    const label = question.substring(0, 40);
    const sim = config.dryRun ? '[SIM] ' : '';

    logger.info(`MM${tag}: ${sim}entering — ${label}`);

    // ── Balance check ───────────────────────────────────────────
    const totalNeeded = config.mmTradeSize * 2; // $10 total → 10 YES + 10 NO
    if (config.dryRun) {
        const simBal = getBalance();
        if (simBal < totalNeeded) {
            logger.error(`MM${tag}: insufficient sim balance $${simBal.toFixed(2)} (need $${totalNeeded})`);
            return;
        }
    } else {
        const balance = await getUsdcBalance();
        if (balance < totalNeeded) {
            logger.error(`MM${tag}: insufficient balance $${balance.toFixed(2)} (need $${totalNeeded})`);
            return;
        }
    }

    // ── Pre-entry liquidity check (midpoint-based) ─────────────
    // For binary markets, raw spread is always 0.01-0.99 (useless).
    // Instead check if midpoints are balanced (~0.50). A one-sided market
    // (YES at 0.70 / NO at 0.30) is unlikely to fill both sides.
    let entryYesMid = null, entryNoMid = null;
    if (config.mmLiquidityCheck) {
        try {
            const client = getClient();
            const [yesMp, noMp] = await Promise.all([
                client.getMidpoint(yesTokenId),
                client.getMidpoint(noTokenId),
            ]);
            entryYesMid = parseFloat(yesMp?.mid ?? yesMp ?? '0') || null;
            entryNoMid = parseFloat(noMp?.mid ?? noMp ?? '0') || null;

            if (entryYesMid && entryNoMid) {
                const imbalance = Math.abs(entryYesMid - entryNoMid);
                if (imbalance > config.mmMinLiquiditySpread) {
                    logger.warn(`MM${tag}: skipping ${label} — market imbalanced (YES: ${entryYesMid.toFixed(3)}, NO: ${entryNoMid.toFixed(3)}, imbalance: ${imbalance.toFixed(3)})`);
                    if (config.dryRun) {
                        recordEvent({ type: 'skip_low_liquidity', amount: 0, market: label,
                            description: `YES mid=${entryYesMid.toFixed(3)}, NO mid=${entryNoMid.toFixed(3)}, imbalance=${imbalance.toFixed(3)}` });
                    }
                    return;
                }
                logger.info(`MM${tag}: liquidity OK — YES: ${entryYesMid.toFixed(3)}, NO: ${entryNoMid.toFixed(3)}, imbalance: ${imbalance.toFixed(3)}`);
            }
        } catch (err) {
            logger.warn(`MM${tag}: liquidity check failed (${err.message}) — proceeding anyway`);
        }
    }

    // ── Split USDC into YES+NO via CTF splitPosition ────────────
    // Deposit mmTradeSize*2 USDC → get mmTradeSize*2 YES + mmTradeSize*2 NO tokens
    // Entry price is exactly $0.50 per token on both sides (no spread, no slippage)
    logger.trade(`MM${tag}: ${sim}splitPosition $${totalNeeded} USDC → YES + NO @ $0.50`);
    let shares;
    try {
        shares = await splitPosition(conditionId, totalNeeded, negRisk);
    } catch (err) {
        logger.error(`MM${tag}: splitPosition failed — ${err.message}`);
        return;
    }

    const entryPrice = 0.50;
    logger.info(`MM${tag}: split done — ${shares} YES + ${shares} NO @ $${entryPrice}`);

    // ── Capture spread & midpoint at entry for tracking ──────────
    let yesSpreadAtEntry = null, noSpreadAtEntry = null;
    let yesMidAtEntry = null, noMidAtEntry = null;
    let yesBestBid = null, yesBestAsk = null, noBestBid = null, noBestAsk = null;
    try {
        const client = getClient();
        const [yesOb, noOb] = await Promise.all([
            client.getOrderBook(yesTokenId),
            client.getOrderBook(noTokenId),
        ]);
        // Extract spread and midpoint from orderbook
        const extractMetrics = (ob) => {
            const bids = ob?.bids || [];
            const asks = ob?.asks || [];
            const bestBid = bids.length > 0 ? parseFloat(bids[0].price) : null;
            const bestAsk = asks.length > 0 ? parseFloat(asks[0].price) : null;
            const mid = bestBid != null && bestAsk != null ? (bestBid + bestAsk) / 2 : null;
            const spread = bestBid != null && bestAsk != null ? bestAsk - bestBid : null;
            return { bestBid, bestAsk, mid, spread };
        };
        const yesM = extractMetrics(yesOb);
        const noM = extractMetrics(noOb);
        yesSpreadAtEntry = yesM.spread; noSpreadAtEntry = noM.spread;
        yesMidAtEntry = yesM.mid; noMidAtEntry = noM.mid;
        yesBestBid = yesM.bestBid; yesBestAsk = yesM.bestAsk;
        noBestBid = noM.bestBid; noBestAsk = noM.bestAsk;
    } catch (err) {
        logger.warn(`MM${tag}: failed to fetch entry orderbook metrics: ${err.message}`);
    }

    if (config.dryRun) {
        recordEvent({ type: 'split', amount: -totalNeeded, description: `split ${label}`, market: label });
        recordPosition({ market: label, conditionId, entryCost: totalNeeded, yesShares: shares, noShares: shares, status: 'open',
            yesSpreadAtEntry, noSpreadAtEntry, yesMidAtEntry, noMidAtEntry });
    }

    // ── Place limit sells ───────────────────────────────────────
    logger.info(`MM${tag}: ${sim}placing limit sells @ $${config.mmSellPrice}`);
    const yesSell = await placeLimitSell(yesTokenId, shares, config.mmSellPrice, tickSize, negRisk);
    const noSell = await placeLimitSell(noTokenId, shares, config.mmSellPrice, tickSize, negRisk);

    if (!yesSell.success || !noSell.success) {
        logger.error(`MM${tag}: failed to place limit sells — cutting immediately`);
    }

    // ── Build position object ───────────────────────────────────
    const pos = {
        asset: asset || 'btc',
        conditionId,
        question,
        endTime,
        tickSize,
        negRisk,
        status: 'monitoring',
        enteredAt: new Date().toISOString(),
        entryYesMid: entryYesMid || yesMidAtEntry,
        entryNoMid: entryNoMid || noMidAtEntry,
        _priceHistory: config.mmMomentum ? { yes: [], no: [] } : null,
        yes: {
            tokenId: yesTokenId,
            shares,
            entryPrice,
            entryCost: config.mmTradeSize,  // $5 per side
            orderId: yesSell.orderId,
            filled: !yesSell.success,    // mark as needing cut if sell failed
            fillPrice: null,
        },
        no: {
            tokenId: noTokenId,
            shares,
            entryPrice,
            entryCost: config.mmTradeSize,
            orderId: noSell.orderId,
            filled: !noSell.success,
            fillPrice: null,
        },
    };

    activePositions.set(conditionId, pos);

    // ── Monitor (runs until done/cut/expired) ───────────────────
    await monitorAndManage(pos);

    if (config.dryRun) {
        const totalPnl = calcPnl(pos);
        // Determine granular exit type and fill count
        const bothFilled = pos.yes.filled && pos.no.filled && pos.status === 'done' && !pos._wasCutLoss;
        const fillCount = (pos.yes.filledAt ? 1 : 0) + (pos.no.filledAt ? 1 : 0);
        let exitType = 'both_filled';
        if (pos.status === 'expired') exitType = 'expired';
        else if (pos._exitType) exitType = pos._exitType;
        else if (pos.status === 'done' && pos._wasCutLoss) exitType = pos._cutLossType || 'cut_loss_market_sell';

        // Capture midpoints at exit
        let yesMidAtExit = null, noMidAtExit = null;
        try {
            const client = getClient();
            const [yesMp, noMp] = await Promise.all([
                client.getMidpoint(pos.yes.tokenId),
                client.getMidpoint(pos.no.tokenId),
            ]);
            yesMidAtExit = parseFloat(yesMp?.mid ?? yesMp ?? '0') || null;
            noMidAtExit = parseFloat(noMp?.mid ?? noMp ?? '0') || null;
        } catch { /* ignore */ }

        // Timing
        const enteredMs = new Date(pos.enteredAt).getTime();
        const firstFillMs = Math.min(pos.yes.filledAt || Infinity, pos.no.filledAt || Infinity);
        const secondFillMs = Math.max(pos.yes.filledAt || 0, pos.no.filledAt || 0);
        const timeToFirstFill = firstFillMs < Infinity ? (firstFillMs - enteredMs) / 1000 : null;
        const timeToSecondFill = (pos.yes.filledAt && pos.no.filledAt) ? (secondFillMs - enteredMs) / 1000 : null;

        recordPosition({ market: label, conditionId, entryCost: totalNeeded, yesShares: pos.yes.shares, noShares: pos.no.shares,
            status: 'closed', exitReason: pos.status, pnl: totalPnl, endTime: pos.endTime,
            yesSpreadAtEntry, noSpreadAtEntry, yesMidAtEntry, noMidAtEntry,
            yesMidAtExit, noMidAtExit, exitType, fillCount, timeToFirstFill, timeToSecondFill });
    }
    activePositions.delete(conditionId);
}
