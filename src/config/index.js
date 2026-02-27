import dotenv from 'dotenv';
dotenv.config();

const config = {
  // Wallet
  privateKey: process.env.PRIVATE_KEY,         // EOA private key (for signing only)
  proxyWallet: process.env.PROXY_WALLET_ADDRESS, // Polymarket proxy wallet (deposit USDC here)
  // 1 = POLY_PROXY (Magic Link / email), 2 = GNOSIS_SAFE (MetaMask etc.). Split/merge in ctf.js require Gnosis Safe.
  signatureType: parseInt(process.env.SIGNATURE_TYPE || '2', 10),

  // Polymarket API (optional, auto-derived if empty)
  clobApiKey: process.env.CLOB_API_KEY || '',
  clobApiSecret: process.env.CLOB_API_SECRET || '',
  clobApiPassphrase: process.env.CLOB_API_PASSPHRASE || '',

  // Polymarket endpoints
  clobHost: 'https://clob.polymarket.com',
  gammaHost: 'https://gamma-api.polymarket.com',
  dataHost: 'https://data-api.polymarket.com',
  chainId: 137,

  // Polygon RPC
  polygonRpcUrl: process.env.POLYGON_RPC_URL || 'https://polygon-bor-rpc.publicnode.com',

  // Trader to copy
  traderAddress: process.env.TRADER_ADDRESS,

  // Trade sizing
  sizeMode: process.env.SIZE_MODE || 'percentage', // "percentage" | "balance"
  sizePercent: parseFloat(process.env.SIZE_PERCENT || '50'),
  minTradeSize: parseFloat(process.env.MIN_TRADE_SIZE || '1'),
  maxPositionSize: parseFloat(process.env.MAX_POSITION_SIZE || '10'),

  // Auto sell
  autoSellEnabled: process.env.AUTO_SELL_ENABLED === 'true',
  autoSellProfitPercent: parseFloat(process.env.AUTO_SELL_PROFIT_PERCENT || '10'),

  // Sell mode when copying sell
  sellMode: process.env.SELL_MODE || 'market', // "market" | "limit"

  // Redeem interval (seconds)
  redeemInterval: parseInt(process.env.REDEEM_INTERVAL || '60', 10) * 1000,

  // Dry run
  dryRun: process.env.DRY_RUN === 'true',
  // Simulation starting balance (MM sim only; overridable via --balance in mm.js)
  simBalance: parseFloat(process.env.SIM_BALANCE || '1000') || 1000,

  // Retry settings
  maxRetries: 5,
  retryDelay: 3000,

  // ── Market Maker ──────────────────────────────────────────────
  mmAssets:        (process.env.MM_ASSETS || 'btc')
                     .split(',').map((s) => s.trim().toLowerCase()).filter(Boolean),
  mmDuration:      process.env.MM_DURATION || '5m',  // '5m' or '15m'
  mmTradeSize:     parseFloat(process.env.MM_TRADE_SIZE     || '5'),    // USDC per side
  mmSellPrice:     parseFloat(process.env.MM_SELL_PRICE     || '0.60'), // limit sell target
  mmCutLossTime:   parseInt(  process.env.MM_CUT_LOSS_TIME  || '60', 10), // seconds before close
  mmMarketKeyword: process.env.MM_MARKET_KEYWORD            || 'Bitcoin Up or Down',
  mmEntryWindow:   parseInt(  process.env.MM_ENTRY_WINDOW   || '45', 10), // max secs after open
  mmPollInterval:  parseInt(  process.env.MM_POLL_INTERVAL  || '10', 10) * 1000,

  // ── Liquidity Check (pre-entry filter) ───────────────────────
  mmLiquidityCheck:      process.env.MM_LIQUIDITY_CHECK !== 'false', // enabled by default
  mmMinLiquiditySpread:  parseFloat(process.env.MM_MAX_IMBALANCE || '0.20'), // max YES-NO midpoint gap to allow entry

  // ── Recovery Buy (after cut-loss) ─────────────────────────────
  // When enabled: after cutting loss, monitor prices for 10s and
  // market-buy the dominant side if it's above threshold and rising/stable.
  mmRecoveryBuy:       process.env.MM_RECOVERY_BUY         === 'true',
  mmRecoveryThreshold: parseFloat(process.env.MM_RECOVERY_THRESHOLD || '0.70'), // min price to qualify
  mmRecoverySize:      parseFloat(process.env.MM_RECOVERY_SIZE      || '0'),    // 0 = use mmTradeSize

  // ── Momentum Strategy (when one side fills, cancel other & trail/add) ───
  mmMomentum:          process.env.MM_MOMENTUM_STRATEGY     === 'true',
  mmMomentumMode:      process.env.MM_MOMENTUM_MODE        || 'trail',  // 'trail' | 'add'
  mmMomentumLookback:  parseInt(process.env.MM_MOMENTUM_LOOKBACK  || '3', 10),
  mmAddTarget:         parseFloat(process.env.MM_ADD_TARGET        || '0.70'),
  mmTrailDropPct:      parseFloat(process.env.MM_TRAIL_DROP_PCT    || '0.05'),

  // ── MM-Momentum (directional momentum strategy) ─────────────────
  momAssets:          (process.env.MOM_ASSETS || process.env.MM_ASSETS || 'btc')
                        .split(',').map((s) => s.trim().toLowerCase()).filter(Boolean),
  momDuration:        process.env.MOM_DURATION || process.env.MM_DURATION || '5m',
  momTradeSize:       parseFloat(process.env.MOM_TRADE_SIZE     || '5'),
  momEntryThreshold:  parseFloat(process.env.MOM_ENTRY_THRESHOLD || '0.60'),
  momExitTarget:      parseFloat(process.env.MOM_EXIT_TARGET     || '0.98'),
  momEntryWindow:     parseInt(  process.env.MOM_ENTRY_WINDOW    || '45', 10),
  momEntryPollMs:     parseInt(  process.env.MOM_ENTRY_POLL_MS   || '2000', 10),
  momCutLossTime:     parseInt(  process.env.MOM_CUT_LOSS_TIME   || '30', 10),
  momTrailEnabled:    process.env.MOM_TRAIL_ENABLED !== 'false',
  momTrailDropPct:    parseFloat(process.env.MOM_TRAIL_DROP_PCT  || '0.05'),
  momMinDepth:        parseFloat(process.env.MOM_MIN_DEPTH       || '0'),
  momPollInterval:    parseInt(  process.env.MOM_POLL_INTERVAL   || '10', 10) * 1000,
  momMaxPositions:    parseInt(  process.env.MOM_MAX_POSITIONS   || '1', 10),

  // ── Orderbook Sniper ───────────────────────────────────────────
  // Places tiny GTC limit BUY orders at a very low price on each side
  // of ETH/SOL/XRP 5-minute markets — catches panic dumps near $0.
  sniperAssets: (process.env.SNIPER_ASSETS || 'eth,sol,xrp')
                  .split(',').map((s) => s.trim().toLowerCase()).filter(Boolean),
  sniperPrice:  parseFloat(process.env.SNIPER_PRICE  || '0.01'), // $ per share
  sniperShares: parseFloat(process.env.SNIPER_SHARES || '5'),    // shares per side
};

// Validation for copy-trade bot
export function validateConfig() {
  const required = ['privateKey', 'proxyWallet', 'traderAddress'];
  const missing = required.filter((key) => !config[key]);
  if (missing.length > 0) {
    throw new Error(`Missing required config: ${missing.join(', ')}. Check your .env file.`);
  }
  if (!['percentage', 'balance'].includes(config.sizeMode)) {
    throw new Error(`Invalid SIZE_MODE: ${config.sizeMode}. Use "percentage" or "balance".`);
  }
  if (!['market', 'limit'].includes(config.sellMode)) {
    throw new Error(`Invalid SELL_MODE: ${config.sellMode}. Use "market" or "limit".`);
  }
}

// Validation for market-maker bot
export function validateMMConfig() {
  const required = ['privateKey', 'proxyWallet'];
  const missing = required.filter((key) => !config[key]);
  if (missing.length > 0) {
    throw new Error(`Missing required config: ${missing.join(', ')}. Check your .env file.`);
  }
  if (config.mmTradeSize <= 0) throw new Error('MM_TRADE_SIZE must be > 0');
  if (config.mmSellPrice <= 0 || config.mmSellPrice >= 1)
    throw new Error('MM_SELL_PRICE must be between 0 and 1');
}

// Validation for mm-momentum bot
export function validateMomentumConfig() {
  const required = ['privateKey', 'proxyWallet'];
  const missing = required.filter((key) => !config[key]);
  if (missing.length > 0) {
    throw new Error(`Missing required config: ${missing.join(', ')}. Check your .env file.`);
  }
  if (config.momTradeSize <= 0) throw new Error('MOM_TRADE_SIZE must be > 0');
  if (config.momEntryThreshold <= 0 || config.momEntryThreshold >= 1)
    throw new Error('MOM_ENTRY_THRESHOLD must be between 0 and 1');
  if (config.momExitTarget <= config.momEntryThreshold || config.momExitTarget > 1)
    throw new Error('MOM_EXIT_TARGET must be > MOM_ENTRY_THRESHOLD and <= 1');
}

export default config;
