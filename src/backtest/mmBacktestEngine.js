/**
 * mmBacktestEngine.js
 * Strategy simulation engine — replays the MM strategy against historical snapshots.
 */

/**
 * Run the MM strategy simulation against a single market's snapshots.
 *
 * @param {object} market - Market metadata from PolyBackTest API
 * @param {Array}  snapshots - Sorted (asc) array of snapshot objects
 * @param {object} params - Strategy parameters
 * @param {number} params.sellPrice - Limit sell target (e.g. 0.60)
 * @param {number} params.cutLossSeconds - Seconds before end_time to trigger cut-loss
 * @param {number} params.entryWindow - Max seconds after start_time to enter
 * @param {number} params.maxImbalance - Max |price_up - price_down| to allow entry
 * @param {boolean} params.liquidityCheck - Whether to check liquidity at entry
 * @param {number} params.tradeSize - USDC per side (shares = tradeSize / 0.50)
 * @param {boolean} params.recovery - Whether to attempt recovery buy
 * @returns {object} result - { status, pnl, details }
 */
export function simulateMarket(market, snapshots, params) {
    const {
        sellPrice = 0.60,
        cutLossSeconds = 60,
        entryWindow = 45,
        maxImbalance = 0.20,
        liquidityCheck = true,
        tradeSize = 5,
        recovery = false,
    } = params;

    const startTime = toTimestamp(market.start_time);
    const endTime = toTimestamp(market.end_time);
    const cutLossTime = endTime - cutLossSeconds;
    const shares = tradeSize / 0.50; // e.g. $5 / $0.50 = 10 shares per side

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
        entryPriceUp: null,
        entryPriceDown: null,
        yesFilled: false,
        noFilled: false,
        yesFillPrice: null,
        noFillPrice: null,
        yesFillTime: null,
        noFillTime: null,
        exitType: '',
        exitPriceUp: null,
        exitPriceDown: null,
        pnl: 0,
        yesPnl: 0,
        noPnl: 0,
        orderbookDepthAtEntry: null,
        orderbookDepthAtFill: null,
        maxPriceUp: null,
        maxPriceDown: null,
    };

    if (!snapshots || snapshots.length === 0) {
        result.skipReason = 'no_snapshots';
        return result;
    }

    // Sort snapshots by time ascending
    snapshots.sort((a, b) => toTimestamp(a.time) - toTimestamp(b.time));

    // Track max YES/NO prices across all snapshots (where prices would've gone)
    let maxPriceUp = 0, maxPriceDown = 0;
    for (const s of snapshots) {
        const pu = parseFloat(s.price_up) || 0;
        const pd = parseFloat(s.price_down) || 0;
        if (pu > maxPriceUp) maxPriceUp = pu;
        if (pd > maxPriceDown) maxPriceDown = pd;
    }
    result.maxPriceUp = maxPriceUp;
    result.maxPriceDown = maxPriceDown;

    // 1. Find entry snapshot — first snapshot within entry_window of start_time
    const entrySnap = snapshots.find((s) => {
        const t = toTimestamp(s.time);
        return t >= startTime && (t - startTime) <= entryWindow;
    });

    if (!entrySnap) {
        result.skipReason = 'no_entry_snapshot';
        return result;
    }

    // 2. Liquidity check — |price_up - price_down| at entry
    const priceUp = parseFloat(entrySnap.price_up) || 0;
    const priceDown = parseFloat(entrySnap.price_down) || 0;
    result.entryPriceUp = priceUp;
    result.entryPriceDown = priceDown;

    if (liquidityCheck) {
        const imbalance = Math.abs(priceUp - priceDown);
        if (imbalance > maxImbalance) {
            result.skipReason = `imbalanced_${imbalance.toFixed(3)}`;
            return result;
        }
    }

    // 3. Virtual position — enter at $0.50 per side
    const entryPrice = 0.50;
    result.status = 'entered';

    // Capture orderbook depth at entry
    result.orderbookDepthAtEntry = getDepthAtPrice(entrySnap.orderbook_up, sellPrice) + getDepthAtPrice(entrySnap.orderbook_down, sellPrice);

    // 4. Scan snapshots after entry for fills
    const entryTime = toTimestamp(entrySnap.time);
    let yesFilled = false, noFilled = false;
    let yesFillPrice = null, noFillPrice = null;
    let yesFillTime = null, noFillTime = null;
    let lastSnap = entrySnap;

    for (const snap of snapshots) {
        const t = toTimestamp(snap.time);
        if (t <= entryTime) continue;

        lastSnap = snap;

        // Check cut-loss time
        if (t >= cutLossTime) break;

        // Check YES fill — price_up >= sellPrice
        if (!yesFilled && parseFloat(snap.price_up) >= sellPrice) {
            const depth = getDepthAtPrice(snap.orderbook_up, sellPrice);
            if (depth >= shares) {
                yesFilled = true;
                yesFillPrice = sellPrice;
                yesFillTime = snap.time;
                result.orderbookDepthAtFill = depth;
            }
        }

        // Check NO fill — price_down >= sellPrice
        if (!noFilled && parseFloat(snap.price_down) >= sellPrice) {
            const depth = getDepthAtPrice(snap.orderbook_down, sellPrice);
            if (depth >= shares) {
                noFilled = true;
                noFillPrice = sellPrice;
                noFillTime = snap.time;
            }
        }

        // Both filled → done
        if (yesFilled && noFilled) break;
    }

    // 5. Record fills
    result.yesFilled = yesFilled;
    result.noFilled = noFilled;
    result.yesFillPrice = yesFillPrice;
    result.noFillPrice = noFillPrice;
    result.yesFillTime = yesFillTime;
    result.noFillTime = noFillTime;

    // 6. Determine exit
    if (yesFilled && noFilled) {
        // Both filled — best case
        result.exitType = 'both_filled';
        result.yesPnl = (sellPrice - entryPrice) * shares;
        result.noPnl = (sellPrice - entryPrice) * shares;
        result.pnl = result.yesPnl + result.noPnl;
        result.status = 'closed';
    } else if (!yesFilled && !noFilled) {
        // Neither filled — merge (P&L = $0)
        result.exitType = 'merge';
        result.pnl = 0;
        result.yesPnl = 0;
        result.noPnl = 0;
        result.status = 'closed';
        result.exitPriceUp = parseFloat(lastSnap.price_up) || 0;
        result.exitPriceDown = parseFloat(lastSnap.price_down) || 0;
    } else {
        // One filled — market-sell the unfilled side at best bid
        result.exitType = 'cut_loss';
        result.status = 'closed';

        if (yesFilled) {
            // YES filled, market-sell NO
            result.yesPnl = (sellPrice - entryPrice) * shares;
            const noExitPrice = getBestBid(lastSnap.orderbook_down) || parseFloat(lastSnap.price_down) || 0;
            result.noPnl = (noExitPrice - entryPrice) * shares;
            result.exitPriceDown = noExitPrice;
            result.exitPriceUp = sellPrice;
        } else {
            // NO filled, market-sell YES
            result.noPnl = (sellPrice - entryPrice) * shares;
            const yesExitPrice = getBestBid(lastSnap.orderbook_up) || parseFloat(lastSnap.price_up) || 0;
            result.yesPnl = (yesExitPrice - entryPrice) * shares;
            result.exitPriceUp = yesExitPrice;
            result.exitPriceDown = sellPrice;
        }

        result.pnl = result.yesPnl + result.noPnl;
    }

    // 7. Recovery buy (optional)
    if (recovery && result.exitType === 'cut_loss') {
        const recoveryPnl = simulateRecovery(snapshots, lastSnap, endTime, shares);
        if (recoveryPnl !== null) {
            result.pnl += recoveryPnl;
            result.exitType = 'cut_loss_recovery';
        }
    }

    return result;
}

// ── Helpers ──────────────────────────────────────────────────────────────────

function toTimestamp(value) {
    if (typeof value === 'number') return value;
    const d = new Date(value);
    return Math.floor(d.getTime() / 1000);
}

/**
 * Sum bid sizes at or above a given price level from an orderbook side.
 * orderbook format: { bids: [{price, size}, ...], asks: [...] }
 */
function getDepthAtPrice(orderbook, price) {
    if (!orderbook || !orderbook.bids) return 0;
    let totalSize = 0;
    for (const bid of orderbook.bids) {
        if (parseFloat(bid.price) >= price) {
            totalSize += parseFloat(bid.size) || 0;
        }
    }
    return totalSize;
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

/**
 * Simulate recovery buy — look at remaining snapshots after cut-loss
 * to see if a directional bet would have been profitable.
 */
function simulateRecovery(snapshots, cutLossSnap, endTime, shares) {
    const cutTime = toTimestamp(cutLossSnap.time);
    const remaining = snapshots.filter((s) => toTimestamp(s.time) > cutTime);
    if (remaining.length < 2) return null;

    // Determine dominant side from price trend
    const firstPriceUp = parseFloat(remaining[0].price_up) || 0.5;
    const lastPriceUp = parseFloat(remaining[remaining.length - 1].price_up) || 0.5;

    // If price_up trending up, buy YES; if down, buy NO
    const buyYes = lastPriceUp > firstPriceUp;
    const entryPrice = buyYes ? firstPriceUp : (parseFloat(remaining[0].price_down) || 0.5);

    if (entryPrice < 0.70) return null; // Must meet recovery threshold

    // Exit at last snapshot price
    const exitPrice = buyYes
        ? (parseFloat(remaining[remaining.length - 1].price_up) || entryPrice)
        : (parseFloat(remaining[remaining.length - 1].price_down) || entryPrice);

    const recoveryShares = shares; // Same size
    return (exitPrice - entryPrice) * recoveryShares;
}
