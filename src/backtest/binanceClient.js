/**
 * binanceClient.js
 * Binance REST API client for fetching klines and long/short ratio.
 * Ported from polymitra-backend/src/services/binance.service.ts
 */

const BINANCE_API = 'https://api.binance.com';
const BINANCE_FAPI = 'https://fapi.binance.com';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/**
 * Fetch OHLCV klines from Binance spot API.
 * @param {string} symbol - e.g. 'BTCUSDT'
 * @param {string} interval - e.g. '1m'
 * @param {number} [limit=60]
 * @param {number} [startTime] - Unix ms
 * @returns {Promise<Array<{openTime,open,high,low,close,volume,closeTime}>>}
 */
export async function fetchKlines(symbol, interval, limit = 60, startTime) {
    const url = new URL('/api/v3/klines', BINANCE_API);
    url.searchParams.set('symbol', symbol);
    url.searchParams.set('interval', interval);
    url.searchParams.set('limit', String(limit));
    if (startTime != null) url.searchParams.set('startTime', String(startTime));

    const res = await fetch(url.toString());
    if (!res.ok) throw new Error(`Binance klines: ${res.status} ${res.statusText}`);
    const data = await res.json();

    return data.map((arr) => {
        const toNum = (x) => {
            const n = Number(x);
            return Number.isFinite(n) ? n : 0;
        };
        return {
            openTime: Number(arr[0]),
            open: toNum(arr[1]),
            high: toNum(arr[2]),
            low: toNum(arr[3]),
            close: toNum(arr[4]),
            volume: toNum(arr[5]),
            closeTime: Number(arr[6]),
        };
    });
}

/**
 * Fetch global long/short account ratio from Binance Futures API.
 * @param {string} symbol - e.g. 'BTCUSDT'
 * @param {string} [period='5m']
 * @param {number} [limit=1]
 * @param {number} [startTime] - Unix ms
 * @param {number} [endTime] - Unix ms
 * @returns {Promise<number|null>} longShortRatio or null
 */
export async function fetchLongShortRatio(symbol, period = '5m', limit = 1, startTime, endTime) {
    const url = new URL('/futures/data/globalLongShortAccountRatio', BINANCE_FAPI);
    url.searchParams.set('symbol', symbol);
    url.searchParams.set('period', period);
    url.searchParams.set('limit', String(limit));
    if (startTime != null) url.searchParams.set('startTime', String(startTime));
    if (endTime != null) url.searchParams.set('endTime', String(endTime));

    const res = await fetch(url.toString());
    if (!res.ok) return null;
    const data = await res.json();

    if (Array.isArray(data) && data.length > 0) {
        const ratio = parseFloat(data[data.length - 1].longShortRatio);
        return Number.isFinite(ratio) ? ratio : null;
    }
    return null;
}

export { sleep };
