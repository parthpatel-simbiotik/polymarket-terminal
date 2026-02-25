/**
 * sniperExecutor.js
 * Places GTC limit BUY orders at a very low price on both sides of a market.
 *
 * Strategy:
 *   - For each market detected by sniperDetector, place two GTC BUY orders:
 *       UP   token at $SNIPER_PRICE × SNIPER_SHARES shares
 *       DOWN token at $SNIPER_PRICE × SNIPER_SHARES shares
 *   - Orders sit in the orderbook. If someone panic-dumps below the price,
 *     the order fills and becomes redeemable if that side wins.
 *   - GTC orders expire automatically when the market closes — no cleanup needed.
 *
 * Cost per market: SNIPER_PRICE × SNIPER_SHARES × 2 sides
 * e.g. $0.01 × 5 × 2 = $0.10 per market, $0.30 for 3 assets per 5-min slot
 */

import { Side, OrderType } from '@polymarket/clob-client';
import config from '../config/index.js';
import { getClient } from './client.js';
import logger from '../utils/logger.js';
import { recordEvent, recordSnipe, getBalance } from '../utils/sniperSimSession.js';

// In-memory tracking of placed snipe orders (for TUI status panel)
const activeSnipes = []; // { asset, side, question, orderId, price, shares, cost, potentialPayout }

export function getActiveSnipes() {
    return [...activeSnipes];
}

export async function executeSnipe(market) {
    const { asset, conditionId, question, yesTokenId, noTokenId, tickSize, negRisk } = market;
    const label = question.slice(0, 40);
    const sim   = config.dryRun ? '[SIM] ' : '';

    const sides = [
        { name: 'UP',   tokenId: yesTokenId },
        { name: 'DOWN', tokenId: noTokenId  },
    ];

    logger.info(`SNIPER: ${sim}${asset.toUpperCase()} — "${label}" | $${config.sniperPrice} × ${config.sniperShares}sh each side`);

    for (const { name, tokenId } of sides) {
        if (config.dryRun) {
            const cost = config.sniperPrice * config.sniperShares;
            const simBal = getBalance();
            if (simBal < cost) {
                logger.error(`SNIPER[SIM]: insufficient sim balance $${simBal.toFixed(2)} (need $${cost.toFixed(3)} for ${asset.toUpperCase()} ${name})`);
                continue;
            }
            recordEvent({ type: 'place_snipe', amount: -cost, market: label, side: name, shares: config.sniperShares, price: config.sniperPrice });
            recordSnipe({
                asset: asset.toUpperCase(),
                side: name,
                question: label,
                orderId: `sim-${Date.now()}-${tokenId.slice(-6)}`,
                price: config.sniperPrice,
                shares: config.sniperShares,
                cost,
                potentialPayout: config.sniperShares,
            });
            logger.trade(`SNIPER[SIM]: ${asset.toUpperCase()} ${name} @ $${config.sniperPrice} × ${config.sniperShares}sh | cost $${cost.toFixed(3)} | payout $${config.sniperShares} if wins`);
            activeSnipes.push({
                asset: asset.toUpperCase(),
                side: name,
                question: label,
                orderId: `sim-${Date.now()}-${tokenId.slice(-6)}`,
                price: config.sniperPrice,
                shares: config.sniperShares,
                cost,
                potentialPayout: config.sniperShares,
            });
            continue;
        }

        const client = getClient();
        try {
            const res = await client.createAndPostOrder(
                {
                    tokenID: tokenId,
                    side:    Side.BUY,
                    price:   config.sniperPrice,
                    size:    config.sniperShares,
                },
                { tickSize, negRisk },
                OrderType.GTC,
            );

            if (res?.success) {
                const cost = config.sniperPrice * config.sniperShares;
                logger.trade(`SNIPER: ${asset.toUpperCase()} ${name} @ $${config.sniperPrice} × ${config.sniperShares}sh | cost $${cost.toFixed(3)} | order ${res.orderID}`);
                activeSnipes.push({
                    asset: asset.toUpperCase(),
                    side: name,
                    question: label,
                    orderId: res.orderID,
                    price: config.sniperPrice,
                    shares: config.sniperShares,
                    cost,
                    potentialPayout: config.sniperShares,
                });
            } else {
                logger.warn(`SNIPER: ${asset.toUpperCase()} ${name} order failed — ${res?.errorMsg || 'unknown'}`);
            }
        } catch (err) {
            logger.error(`SNIPER: ${asset.toUpperCase()} ${name} error — ${err.message}`);
        }
    }
}
