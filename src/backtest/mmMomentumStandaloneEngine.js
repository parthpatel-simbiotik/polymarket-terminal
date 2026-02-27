/**
 * mmMomentumStandaloneEngine.js
 * Backtest engine for the standalone MM-Momentum strategy.
 *
 * Strategy:
 *   1. After market opens, within entryWindow seconds, check if either
 *      UP or DOWN crosses above entryThreshold
 *   2. Buy that side at the snapshot's market price (best ask or midpoint)
 *   3. Hold until exitTarget, trail stop, or cut-loss before expiry
 *
 * Different from mmMomentumEngine.js which is an add-on to the base MM split strategy.
 */

/**
 * @param {object} market - Market metadata from PolyBackTest API
 * @param {Array}  snapshots - Sorted (asc) array of snapshot objects
 * @param {object} params
 * @param {number} params.entryThreshold - Price above which to buy (e.g. 0.60)
 * @param {number} params.exitTarget - Target price to sell (e.g. 0.98)
 * @param {number} params.entryWindow - Max seconds after start to enter
 * @param {number} params.cutLossSeconds - Seconds before end to force exit
 * @param {number} params.tradeSize - USDC to spend
 * @param {boolean} params.trailEnabled - Whether to use trailing stop
 * @param {number} params.trailDropPct - % drop from high to trigger trail
 * @param {number} params.minDepth - Min orderbook depth to enter
 * @returns {object} result
 */
export function simulateMomentumStandalone(market, snapshots, params) {
    const {
        entryThreshold = 0.60,
        exitTarget = 0.98,
        entryWindow = 45,
        cutLossSeconds = 30,
        tradeSize = 5,
        trailEnabled = true,
        trailDropPct = 0.05,
        minDepth = 0,
    } = params;

    const startTime = toTimestamp(market.start_time);
    const endTime = toTimestamp(market.end_time);
    const cutLossTime = endTime - cutLossSeconds;

    const result = {
        marketId: market.market_id,
        slug: market.slug || '',
        startTime: market.start_time,
        endTime: market.end_time,
        winner: market.winner || '',
        btcPriceStart: market.btc_price_start,
        btcPriceEnd: market.btc_price_end,
        finalVolume: market.final_volume,
        finalLiquidity: market.final_liquidity,
        status: 'skipped',
        skipReason: '',
        entrySide: null,
        entryPrice: null,
        entryTime: null,
        entrySecondsFromStart: null,
        entryPriceUp: null,
        entryPriceDown: null,
        shares: null,
        exitPrice: null,
        exitTime: null,
        exitType: '',
        pnl: 0,
        maxPriceUp: null,
        maxPriceDown: null,
        maxPriceAfterEntry: null,
        depthAtEntry: null,
    };

    if (!snapshots || snapshots.length === 0) {
        result.skipReason = 'no_snapshots';
        return result;
    }

    snapshots.sort((a, b) => toTimestamp(a.time) - toTimestamp(b.time));

    // Track max prices across all snapshots
    let maxPriceUp = 0, maxPriceDown = 0;
    for (const s of snapshots) {
        const pu = parseFloat(s.price_up) || 0;
        const pd = parseFloat(s.price_down) || 0;
        if (pu > maxPriceUp) maxPriceUp = pu;
        if (pd > maxPriceDown) maxPriceDown = pd;
    }
    result.maxPriceUp = maxPriceUp;
    result.maxPriceDown = maxPriceDown;

    // 1. Find entry: first snapshot within entryWindow where UP or DOWN > threshold
    let entrySnap = null;
    let entrySide = null;

    for (const snap of snapshots) {
        const t = toTimestamp(snap.time);
        if (t < startTime) continue;
        if ((t - startTime) > entryWindow) break;

        const priceUp = parseFloat(snap.price_up) || 0;
        const priceDown = parseFloat(snap.price_down) || 0;

        if (priceUp >= entryThreshold || priceDown >= entryThreshold) {
            // Pick the stronger side
            if (priceUp >= entryThreshold && priceDown >= entryThreshold) {
                entrySide = priceUp >= priceDown ? 'yes' : 'no';
            } else if (priceUp >= entryThreshold) {
                entrySide = 'yes';
            } else {
                entrySide = 'no';
            }

            // Depth check
            if (minDepth > 0) {
                const ob = entrySide === 'yes' ? snap.orderbook_up : snap.orderbook_down;
                const depth = getDepthAbovePrice(ob, entryThreshold * 0.95);
                if (depth < minDepth) continue;
                result.depthAtEntry = depth;
            }

            entrySnap = snap;
            break;
        }
    }

    if (!entrySnap) {
        result.skipReason = 'no_breakout';
        return result;
    }

    // 2. Compute entry price — use best ask or midpoint from orderbook
    const entryOb = entrySide === 'yes' ? entrySnap.orderbook_up : entrySnap.orderbook_down;
    const midpointPrice = entrySide === 'yes'
        ? parseFloat(entrySnap.price_up) || 0
        : parseFloat(entrySnap.price_down) || 0;
    const bestAsk = getBestAsk(entryOb);
    const entryPrice = bestAsk ?? midpointPrice;
    const shares = tradeSize / entryPrice;

    result.status = 'entered';
    result.entrySide = entrySide;
    result.entryPrice = entryPrice;
    result.entryTime = entrySnap.time;
    result.entrySecondsFromStart = toTimestamp(entrySnap.time) - startTime;
    result.entryPriceUp = parseFloat(entrySnap.price_up) || 0;
    result.entryPriceDown = parseFloat(entrySnap.price_down) || 0;
    result.shares = shares;

    if (minDepth > 0 && !result.depthAtEntry) {
        result.depthAtEntry = getDepthAbovePrice(entryOb, entryThreshold * 0.95);
    }

    // 3. Scan post-entry snapshots for exit
    const entryTime = toTimestamp(entrySnap.time);
    let highBid = entryPrice;
    let maxPriceAfterEntry = entryPrice;

    for (const snap of snapshots) {
        const t = toTimestamp(snap.time);
        if (t <= entryTime) continue;

        const currentPrice = entrySide === 'yes'
            ? parseFloat(snap.price_up) || 0
            : parseFloat(snap.price_down) || 0;

        if (currentPrice > maxPriceAfterEntry) maxPriceAfterEntry = currentPrice;

        // Exit target hit
        if (currentPrice >= exitTarget) {
            result.exitPrice = exitTarget;
            result.exitTime = snap.time;
            result.exitType = 'target_hit';
            result.pnl = (exitTarget - entryPrice) * shares;
            result.status = 'closed';
            result.maxPriceAfterEntry = maxPriceAfterEntry;
            return result;
        }

        // Trail stop
        if (trailEnabled) {
            const ob = entrySide === 'yes' ? snap.orderbook_up : snap.orderbook_down;
            const bid = getBestBid(ob) ?? currentPrice;
            if (bid > highBid) highBid = bid;
            const threshold = highBid * (1 - trailDropPct);
            if (highBid > entryPrice && bid < threshold) {
                result.exitPrice = bid;
                result.exitTime = snap.time;
                result.exitType = 'trail_stop';
                result.pnl = (bid - entryPrice) * shares;
                result.status = 'closed';
                result.maxPriceAfterEntry = maxPriceAfterEntry;
                return result;
            }
        }

        // Cut-loss time
        if (t >= cutLossTime) {
            const ob = entrySide === 'yes' ? snap.orderbook_up : snap.orderbook_down;
            const exitPrice = getBestBid(ob) ?? currentPrice;
            result.exitPrice = exitPrice;
            result.exitTime = snap.time;
            result.exitType = 'cut_loss';
            result.pnl = (exitPrice - entryPrice) * shares;
            result.status = 'closed';
            result.maxPriceAfterEntry = maxPriceAfterEntry;
            return result;
        }
    }

    // If we get here, use last snapshot for exit
    const lastSnap = snapshots[snapshots.length - 1];
    const lastPrice = entrySide === 'yes'
        ? parseFloat(lastSnap.price_up) || 0
        : parseFloat(lastSnap.price_down) || 0;
    const lastOb = entrySide === 'yes' ? lastSnap.orderbook_up : lastSnap.orderbook_down;
    const exitPrice = getBestBid(lastOb) ?? lastPrice;

    result.exitPrice = exitPrice;
    result.exitTime = lastSnap.time;
    result.exitType = 'expiry';
    result.pnl = (exitPrice - entryPrice) * shares;
    result.status = 'closed';
    result.maxPriceAfterEntry = maxPriceAfterEntry;
    return result;
}

// ── Helpers ──────────────────────────────────────────────────────────────────

function toTimestamp(value) {
    if (typeof value === 'number') return value;
    const d = new Date(value);
    return Math.floor(d.getTime() / 1000);
}

function getBestBid(orderbook) {
    if (!orderbook || !orderbook.bids || orderbook.bids.length === 0) return null;
    let best = 0;
    for (const bid of orderbook.bids) {
        const p = parseFloat(bid.price);
        if (p > best) best = p;
    }
    return best > 0 ? best : null;
}

function getBestAsk(orderbook) {
    if (!orderbook || !orderbook.asks || orderbook.asks.length === 0) return null;
    let best = Infinity;
    for (const ask of orderbook.asks) {
        const p = parseFloat(ask.price);
        if (p < best) best = p;
    }
    return best < Infinity ? best : null;
}

/**
 * Sum bid sizes at or above a given price level.
 */
function getDepthAbovePrice(orderbook, price) {
    if (!orderbook || !orderbook.bids) return 0;
    let total = 0;
    for (const bid of orderbook.bids) {
        if (parseFloat(bid.price) >= price) {
            total += parseFloat(bid.size) || 0;
        }
    }
    return total;
}
