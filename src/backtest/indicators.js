/**
 * indicators.js
 * Technical indicator computations: RSI, MACD, VWAP.
 * Ported from polymitra-backend/src/indicators/ (TS → JS).
 */

// ── RSI ──────────────────────────────────────────────────────────────────────

function clamp(x, min, max) {
    return Math.max(min, Math.min(max, x));
}

/**
 * Compute RSI (Relative Strength Index).
 * @param {number[]} closes - Array of closing prices
 * @param {number} period - RSI period (typically 14)
 * @returns {number|null}
 */
export function computeRsi(closes, period) {
    if (!closes?.length || closes.length < period + 1) return null;
    let gains = 0;
    let losses = 0;
    for (let i = closes.length - period; i < closes.length; i++) {
        const diff = closes[i] - closes[i - 1];
        if (diff > 0) gains += diff;
        else losses += -diff;
    }
    const avgLoss = losses / period;
    if (avgLoss === 0) return 100;
    const rs = (gains / period) / avgLoss;
    return clamp(100 - 100 / (1 + rs), 0, 100);
}

// ── MACD ─────────────────────────────────────────────────────────────────────

function ema(values, period) {
    if (!values?.length || values.length < period) return null;
    const k = 2 / (period + 1);
    let prev = values[0];
    for (let i = 1; i < values.length; i++) {
        prev = values[i] * k + prev * (1 - k);
    }
    return prev;
}

/**
 * Compute MACD (Moving Average Convergence Divergence).
 * @param {number[]} closes - Array of closing prices
 * @param {number} fast - Fast EMA period (typically 12)
 * @param {number} slow - Slow EMA period (typically 26)
 * @param {number} signal - Signal EMA period (typically 9)
 * @returns {{macd: number, signal: number, hist: number, histDelta: number|null}|null}
 */
export function computeMacd(closes, fast, slow, signal) {
    if (!closes?.length || closes.length < slow + signal) return null;
    const fastEma = ema(closes, fast);
    const slowEma = ema(closes, slow);
    if (fastEma == null || slowEma == null) return null;

    const macdSeries = [];
    for (let i = 0; i < closes.length; i++) {
        const sub = closes.slice(0, i + 1);
        const f = ema(sub, fast);
        const s = ema(sub, slow);
        if (f != null && s != null) macdSeries.push(f - s);
    }

    const macdLine = fastEma - slowEma;
    const signalLine = ema(macdSeries, signal);
    if (signalLine == null) return null;

    const hist = macdLine - signalLine;
    const prevHist =
        macdSeries.length >= signal + 1
            ? macdSeries[macdSeries.length - 2] -
              (ema(macdSeries.slice(0, -1), signal) ?? 0)
            : null;

    return {
        macd: macdLine,
        signal: signalLine,
        hist,
        histDelta: prevHist != null ? hist - prevHist : null,
    };
}

// ── VWAP ─────────────────────────────────────────────────────────────────────

/**
 * Compute session VWAP from kline candles.
 * @param {Array<{high: number, low: number, close: number, volume: number}>} candles
 * @returns {number|null}
 */
// ── ATR (Average True Range) ─────────────────────────────────────────────

/**
 * Compute ATR — average of true ranges over the last `period` candles.
 * True Range = max(high-low, |high-prevClose|, |low-prevClose|)
 * @param {Array<{high: number, low: number, close: number}>} candles
 * @param {number} period - ATR period (typically 14)
 * @returns {number|null}
 */
export function computeAtr(candles, period) {
    if (!candles?.length || candles.length < period + 1) return null;
    let sum = 0;
    for (let i = candles.length - period; i < candles.length; i++) {
        const prev = candles[i - 1];
        const c = candles[i];
        const tr = Math.max(
            c.high - c.low,
            Math.abs(c.high - prev.close),
            Math.abs(c.low - prev.close),
        );
        sum += tr;
    }
    return sum / period;
}

// ── Bollinger Band Width ─────────────────────────────────────────────────

/**
 * Compute Bollinger Band Width (normalized).
 * BBW = (Upper - Lower) / Middle = 2 * stddev * multiplier / SMA
 * Lower BBW = tighter bands = lower volatility = better for MM.
 * @param {number[]} closes - Array of closing prices
 * @param {number} period - SMA period (typically 20)
 * @param {number} mult - Standard deviation multiplier (typically 2)
 * @returns {number|null} BBW as a ratio (e.g. 0.005 = 0.5%)
 */
export function computeBBWidth(closes, period, mult = 2) {
    if (!closes?.length || closes.length < period) return null;
    const slice = closes.slice(-period);
    const sma = slice.reduce((a, b) => a + b, 0) / period;
    if (sma === 0) return null;
    const variance = slice.reduce((sum, v) => sum + (v - sma) ** 2, 0) / period;
    const stddev = Math.sqrt(variance);
    return (2 * mult * stddev) / sma;
}

// ── VWAP ─────────────────────────────────────────────────────────────────

export function computeSessionVwap(candles) {
    if (!candles?.length) return null;
    let pv = 0;
    let v = 0;
    for (const c of candles) {
        const tp = (c.high + c.low + c.close) / 3;
        pv += tp * c.volume;
        v += c.volume;
    }
    return v > 0 ? pv / v : null;
}
