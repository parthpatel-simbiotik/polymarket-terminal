/**
 * mmMomentumEngine.js
 * Momentum strategy: when one side fills and momentum is one-sided,
 * cancel the other side, then either add to the winning side or trail profit on the unfilled side.
 */

import { simulateMarket } from './mmBacktestEngine.js';

/**
 * Check if momentum is one-sided at fill time using price trend in recent snapshots.
 * YES filled + price_up trending up = momentum up.
 * NO filled + price_down trending up = momentum down (NO winning).
 *
 * @param {Array} snapshots - Sorted snapshots
 * @param {number} fillIndex - Index of snapshot where fill occurred
 * @param {boolean} yesFilled - True if YES filled
 * @param {number} momentumLookback - Number of snapshots to look back
 * @returns {boolean}
 */
function isMomentumOneSided(snapshots, fillIndex, yesFilled, momentumLookback = 3) {
    if (fillIndex < momentumLookback) return false;

    const prices = [];
    for (let i = fillIndex - momentumLookback; i <= fillIndex; i++) {
        const p = yesFilled
            ? parseFloat(snapshots[i]?.price_up) || 0
            : parseFloat(snapshots[i]?.price_down) || 0;
        prices.push(p);
    }

    // Simple trend: current price > price lookback ago
    const first = prices[0];
    const last = prices[prices.length - 1];
    return last > first;
}

/**
 * Get best (highest) bid price from an orderbook side.
 */
function getBestBid(orderbook) {
    if (!orderbook || !orderbook.bids || orderbook.bids.length === 0) return null;
    let best = 0;
    for (const bid of orderbook.bids) {
        const p = parseFloat(bid.price);
        if (p > best) best = p;
    }
    return best > 0 ? best : null;
}

function toTimestamp(value) {
    if (typeof value === 'number') return value;
    const d = new Date(value);
    return Math.floor(d.getTime() / 1000);
}

/**
 * Run the momentum strategy simulation.
 * Same entry as MM, but when one side fills and momentum is confirmed:
 * - Cancel other side (don't market-sell immediately)
 * - Mode "add": buy more of the filled side, exit at addTarget or cut-loss
 * - Mode "trail": trail profit on unfilled side — sell at best achievable price in remaining window
 *
 * @param {object} market - Market metadata
 * @param {Array} snapshots - Sorted snapshots
 * @param {object} params - Strategy params + momentumMode, momentumLookback, addTarget, trailRealistic
 * @param {boolean} [params.trailRealistic=false] - If true, trail simulates real-time: sell when bid drops X% from high (no look-ahead)
 * @returns {object} result
 */
export function simulateMarketMomentum(market, snapshots, params) {
    const baseParams = { ...params, recovery: false };
    const {
        momentumMode = 'trail',      // 'add' | 'trail'
        momentumLookback = 3,
        addTarget = 0.70,
        trailRealistic = true,      // false = optimistic look-ahead (max bid); true = sell when bid drops from peak
        trailDropPct = 0.05,        // when trailRealistic: sell when bid drops 5% from local high
    } = params;

    // Run base MM sim first to get fills — we'll override exit logic for one-filled + momentum case
    const result = simulateMarket(market, snapshots, baseParams);

    // Only apply momentum logic when exactly one side filled (cut_loss)
    if (result.exitType !== 'cut_loss') return result;

    // Find fill snapshot index for momentum check
    snapshots.sort((a, b) => toTimestamp(a.time) - toTimestamp(b.time));
    const startTime = toTimestamp(market.start_time);
    const entryWindow = params.entryWindow || 45;
    const entrySnap = snapshots.find((s) => {
        const t = toTimestamp(s.time);
        return t >= startTime && (t - startTime) <= entryWindow;
    });
    const entryTime = entrySnap ? toTimestamp(entrySnap.time) : startTime;
    const cutLossTime = toTimestamp(market.end_time) - (params.cutLossSeconds || 60);
    const sellPrice = params.sellPrice || 0.60;
    const shares = (params.tradeSize || 5) / 0.50;
    const entryPrice = 0.50;

    let fillIndex = -1;
    for (let i = 0; i < snapshots.length; i++) {
        const t = toTimestamp(snapshots[i].time);
        if (t <= entryTime) continue;
        if (t >= cutLossTime) break;
        const pu = parseFloat(snapshots[i].price_up) || 0;
        const pd = parseFloat(snapshots[i].price_down) || 0;
        if (result.yesFilled && pu >= sellPrice) {
            fillIndex = i;
            break;
        }
        if (result.noFilled && pd >= sellPrice) {
            fillIndex = i;
            break;
        }
    }

    if (fillIndex < 0) return result;

    const yesFilled = result.yesFilled;
    const momentumConfirmed = isMomentumOneSided(snapshots, fillIndex, yesFilled, momentumLookback);

    if (!momentumConfirmed) return result;

    // Momentum confirmed — apply momentum exit
    const fillSnap = snapshots[fillIndex];
    const remaining = snapshots.filter((s) => toTimestamp(s.time) > toTimestamp(fillSnap.time));

    if (momentumMode === 'add') {
        // Add to winning side: buy more at fill snapshot, exit at addTarget or cut-loss
        const addEntryPrice = yesFilled
            ? parseFloat(fillSnap.price_up) || sellPrice
            : parseFloat(fillSnap.price_down) || sellPrice;

        let addExitPrice = null;
        for (const snap of remaining) {
            const t = toTimestamp(snap.time);
            if (t >= cutLossTime) break;
            const p = yesFilled
                ? parseFloat(snap.price_up) || 0
                : parseFloat(snap.price_down) || 0;
            if (p >= addTarget) {
                addExitPrice = addTarget;
                break;
            }
        }

        if (addExitPrice == null) {
            const lastRemaining = remaining.filter((s) => toTimestamp(s.time) < cutLossTime).pop();
            addExitPrice = lastRemaining
                ? (yesFilled ? parseFloat(lastRemaining.price_up) : parseFloat(lastRemaining.price_down)) || addEntryPrice
                : addEntryPrice;
        }

        const addPnl = (addExitPrice - addEntryPrice) * shares;

        // Unfilled side: market-sell at cut-loss (cancelled the limit, exit at best available before cut-loss)
        const preCutLoss = remaining.filter((s) => toTimestamp(s.time) < cutLossTime);
        const lastSnap = preCutLoss.length > 0 ? preCutLoss[preCutLoss.length - 1] : fillSnap;
        const unfilledExitPrice = yesFilled
            ? getBestBid(lastSnap?.orderbook_up) || parseFloat(lastSnap?.price_up) || 0
            : getBestBid(lastSnap?.orderbook_down) || parseFloat(lastSnap?.price_down) || 0;

        if (yesFilled) {
            result.yesPnl = (sellPrice - entryPrice) * shares + addPnl;
            result.noPnl = (unfilledExitPrice - entryPrice) * shares;
            result.exitPriceUp = addExitPrice;
            result.exitPriceDown = unfilledExitPrice;
        } else {
            result.noPnl = (sellPrice - entryPrice) * shares + addPnl;
            result.yesPnl = (unfilledExitPrice - entryPrice) * shares;
            result.exitPriceUp = unfilledExitPrice;
            result.exitPriceDown = addExitPrice;
        }
        result.pnl = result.yesPnl + result.noPnl;
        result.exitType = 'momentum_add';
        result.momentumDirection = yesFilled ? 'YES' : 'NO';
    } else {
        // Trail profit on unfilled side
        const preCutLoss = remaining.filter((s) => toTimestamp(s.time) < cutLossTime);
        let trailExitPrice;

        if (trailRealistic) {
            // Realistic: sequential scan, sell when bid drops trailDropPct from running high (simulates real-time)
            let highBid = 0;
            for (const snap of preCutLoss) {
                const ob = yesFilled ? snap.orderbook_up : snap.orderbook_down;
                const bid = getBestBid(ob) ?? 0;
                if (bid > highBid) highBid = bid;
                const threshold = highBid * (1 - trailDropPct);
                if (highBid > 0 && bid < threshold) {
                    trailExitPrice = bid;
                    break;
                }
            }
            if (trailExitPrice == null) {
                const lastPreCut = preCutLoss[preCutLoss.length - 1];
                trailExitPrice = getBestBid(yesFilled ? lastPreCut?.orderbook_up : lastPreCut?.orderbook_down)
                    ?? (yesFilled ? parseFloat(lastPreCut?.price_up) : parseFloat(lastPreCut?.price_down)) ?? 0;
            }
        } else {
            // Optimistic (look-ahead): pick max bid across all snapshots — NOT achievable in real time
            let bestBid = 0;
            for (const snap of preCutLoss) {
                const ob = yesFilled ? snap.orderbook_up : snap.orderbook_down;
                const bid = getBestBid(ob);
                if (bid != null && bid > bestBid) bestBid = bid;
            }
            const lastPreCut = preCutLoss[preCutLoss.length - 1];
            trailExitPrice = bestBid > 0 ? bestBid : (yesFilled ? parseFloat(lastPreCut?.price_up) : parseFloat(lastPreCut?.price_down)) ?? 0;
        }

        if (yesFilled) {
            result.yesPnl = (sellPrice - entryPrice) * shares;
            result.noPnl = (trailExitPrice - entryPrice) * shares;
            result.exitPriceUp = sellPrice;
            result.exitPriceDown = trailExitPrice;
        } else {
            result.noPnl = (sellPrice - entryPrice) * shares;
            result.yesPnl = (trailExitPrice - entryPrice) * shares;
            result.exitPriceUp = trailExitPrice;
            result.exitPriceDown = sellPrice;
        }
        result.pnl = result.yesPnl + result.noPnl;
        result.exitType = 'momentum_trail';
        result.momentumDirection = yesFilled ? 'YES' : 'NO';
    }

    return result;
}
