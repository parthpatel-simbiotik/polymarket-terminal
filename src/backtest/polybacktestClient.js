/**
 * polybacktestClient.js
 * API client for PolyBackTest.com — fetches historical market data and snapshots.
 */

import dotenv from 'dotenv';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';
dotenv.config();

const __dirname = dirname(fileURLToPath(import.meta.url));
const CACHE_DIR = join(__dirname, '../../data/snapshot-caches');

const BASE_URL = 'https://api.polybacktest.com';
const API_KEY = process.env.POLYBACKTEST_API_KEY || '';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function apiFetch(path, params = {}) {
    const url = new URL(`${BASE_URL}${path}`);
    for (const [k, v] of Object.entries(params)) {
        if (v != null) url.searchParams.set(k, String(v));
    }

    const res = await fetch(url.toString(), {
        headers: { 'X-API-Key': API_KEY, 'Accept': 'application/json' },
    });

    if (res.status === 429) {
        // Rate limited — wait and retry once
        await sleep(2000);
        const retry = await fetch(url.toString(), {
            headers: { 'X-API-Key': API_KEY, 'Accept': 'application/json' },
        });
        if (!retry.ok) throw new Error(`API ${retry.status}: ${await retry.text()}`);
        return retry.json();
    }

    if (!res.ok) throw new Error(`API ${res.status}: ${await res.text()}`);
    return res.json();
}

/**
 * List resolved markets for a given duration.
 * Paginates automatically; stops gracefully on 402 (free plan limit).
 * @param {string} duration - '5m' or '15m'
 * @param {number} [maxMarkets=0] - 0 = fetch as many as allowed
 * @returns {Promise<Array>} array of market objects
 */
export async function listMarkets(duration, maxMarkets = 0) {
    const marketType = duration;
    const allMarkets = [];
    let offset = 0;
    const limit = 100;

    while (true) {
        let data;
        try {
            data = await apiFetch('/v1/markets', {
                market_type: marketType,
                limit,
                offset,
            });
        } catch (err) {
            // 402 = free plan limit reached — return what we have so far
            if (err.message.includes('402') && allMarkets.length > 0) break;
            throw err;
        }

        const markets = Array.isArray(data) ? data : (data.markets || data.data || []);
        if (markets.length === 0) break;

        allMarkets.push(...markets);

        // Stop if we've hit the requested cap
        if (maxMarkets > 0 && allMarkets.length >= maxMarkets) break;
        if (markets.length < limit) break;
        offset += limit;

        await sleep(200);
    }

    if (maxMarkets > 0) return allMarkets.slice(0, maxMarkets);
    return allMarkets;
}

/**
 * Get all snapshots for a market, including orderbook data.
 * @param {string} marketId
 * @returns {Promise<Array>} array of snapshot objects
 */
export async function getSnapshots(marketId) {
    // Check cache first
    const cachePath = join(CACHE_DIR, `${marketId}.json`);
    if (existsSync(cachePath)) {
        const cached = JSON.parse(readFileSync(cachePath, 'utf-8'));
        return cached;
    }

    const allSnapshots = [];
    let offset = 0;
    const limit = 1000;

    while (true) {
        const data = await apiFetch(`/v1/markets/${marketId}/snapshots`, {
            include_orderbook: true,
            limit,
            offset,
        });

        const snapshots = Array.isArray(data) ? data : (data.snapshots || data.data || []);
        if (snapshots.length === 0) break;

        allSnapshots.push(...snapshots);
        if (snapshots.length < limit) break;
        offset += limit;

        await sleep(200);
    }

    // Write to cache
    if (allSnapshots.length > 0) {
        try {
            mkdirSync(CACHE_DIR, { recursive: true });
            writeFileSync(cachePath, JSON.stringify(allSnapshots));
        } catch { /* ignore cache write errors */ }
    }

    return allSnapshots;
}
