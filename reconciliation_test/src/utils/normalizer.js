/**
 * Fuzzy Asset Matcher
 *
 * Strategy:
 *   1. Exact alias lookup first (O(1)) — fastest, handles known aliases.
 *   2. Fuzzy match against all known canonical forms if exact fails.
 *   3. Accept a fuzzy match only if its normalized similarity score
 *      exceeds FUZZY_SIMILARITY_THRESHOLD (configurable).
 *   4. If nothing qualifies, fall back to uppercasing the raw input.
 *
 * Normalized similarity = 1 - (editDistance / maxLength)
 * Score of 1.0 = identical strings. Score of 0.0 = completely different.
 */

const ASSET_ALIASES = {
  // Bitcoin
  bitcoin: 'BTC',
  'bitcoin (btc)': 'BTC',
  btc: 'BTC',
  xbt: 'BTC',
  'wrapped bitcoin': 'WBTC',
  wbtc: 'WBTC',

  // Ethereum
  ethereum: 'ETH',
  'ethereum (eth)': 'ETH',
  eth: 'ETH',
  ether: 'ETH',
  'wrapped ether': 'WETH',
  weth: 'WETH',

  // Stablecoins
  tether: 'USDT',
  'tether usd': 'USDT',
  usdt: 'USDT',
  'usd coin': 'USDC',
  'usd-coin': 'USDC',
  usdc: 'USDC',
  'binance usd': 'BUSD',
  busd: 'BUSD',
  dai: 'DAI',
  'multi-collateral dai': 'DAI',

  // Major alts
  binancecoin: 'BNB',
  'binance coin': 'BNB',
  bnb: 'BNB',
  ripple: 'XRP',
  xrp: 'XRP',
  cardano: 'ADA',
  ada: 'ADA',
  solana: 'SOL',
  sol: 'SOL',
  dogecoin: 'DOGE',
  doge: 'DOGE',
  polkadot: 'DOT',
  dot: 'DOT',
  avalanche: 'AVAX',
  avax: 'AVAX',
  chainlink: 'LINK',
  link: 'LINK',
  polygon: 'MATIC',
  matic: 'MATIC',
  uniswap: 'UNI',
  uni: 'UNI',
  litecoin: 'LTC',
  ltc: 'LTC',
  'shiba inu': 'SHIB',
  shib: 'SHIB',
  cosmos: 'ATOM',
  atom: 'ATOM',
  stellar: 'XLM',
  xlm: 'XLM',
  'bitcoin cash': 'BCH',
  bch: 'BCH',
  monero: 'XMR',
  xmr: 'XMR',
  tron: 'TRX',
  trx: 'TRX',
  'near protocol': 'NEAR',
  near: 'NEAR',
};

const CANONICAL_TICKERS = [...new Set(Object.values(ASSET_ALIASES))];

const FUZZY_SIMILARITY_THRESHOLD = 0.75;

// ─── Levenshtein Distance ────────────────────────────────────────────────────

/**
 * Computes the Levenshtein edit distance between two strings.
 * Uses the space-optimized two-row rolling array: O(min(m,n)) space, O(m*n) time.
 * @param {string} a
 * @param {string} b
 * @returns {number}
 */
const levenshteinDistance = (a, b) => {
  if (a.length > b.length) [a, b] = [b, a];

  const m = a.length;
  const n = b.length;

  if (m === 0) return n;
  if (n === 0) return m;

  let prev = Array.from({ length: n + 1 }, (_, j) => j);
  let curr = new Array(n + 1);

  for (let i = 1; i <= m; i++) {
    curr[0] = i;
    for (let j = 1; j <= n; j++) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      curr[j] = Math.min(
        prev[j] + 1,
        curr[j - 1] + 1,
        prev[j - 1] + cost
      );
    }
    [prev, curr] = [curr, prev];
  }

  return prev[n];
};

/**
 * Normalized similarity: 1.0 = identical, 0.0 = completely different.
 * @param {string} a
 * @param {string} b
 * @returns {number}
 */
const normalizedSimilarity = (a, b) => {
  const maxLen = Math.max(a.length, b.length);
  if (maxLen === 0) return 1.0;
  return 1 - levenshteinDistance(a, b) / maxLen;
};

// ─── Public API ──────────────────────────────────────────────────────────────

/**
 * Normalizes an asset name/ticker to a canonical uppercase ticker.
 *
 * Resolution order:
 *   1. Exact alias match  → canonical ticker         (O(1))
 *   2. Levenshtein fuzzy  → best-scoring canonical   (O(k * max_len))
 *   3. Fallback           → uppercase raw input
 *
 * @param {string} asset
 * @returns {{ canonical: string, method: 'exact'|'fuzzy'|'fallback', similarity: number|null, originalInput: string }}
 */
const normalizeAsset = (asset) => {
  if (!asset || typeof asset !== 'string') {
    return { canonical: null, method: null, similarity: null, originalInput: asset };
  }

  const trimmed = asset.trim();
  const key = trimmed.toLowerCase();

  // Pass 1: Exact lookup
  if (ASSET_ALIASES[key]) {
    return { canonical: ASSET_ALIASES[key], method: 'exact', similarity: 1.0, originalInput: trimmed };
  }

  // Pass 2: Fuzzy match — compare against both short tickers and full alias names
  const upperKey = key.toUpperCase();
  let bestTicker = null;
  let bestScore = 0;

  for (const ticker of CANONICAL_TICKERS) {
    const score = normalizedSimilarity(upperKey, ticker);
    if (score > bestScore) { bestScore = score; bestTicker = ticker; }
  }

  for (const [aliasKey, canonical] of Object.entries(ASSET_ALIASES)) {
    const score = normalizedSimilarity(key, aliasKey);
    if (score > bestScore) { bestScore = score; bestTicker = canonical; }
  }

  if (bestScore >= FUZZY_SIMILARITY_THRESHOLD && bestTicker) {
    return {
      canonical: bestTicker,
      method: 'fuzzy',
      similarity: parseFloat(bestScore.toFixed(4)),
      originalInput: trimmed,
    };
  }

  // Pass 3: Unknown asset — preserve as-is
  return { canonical: upperKey, method: 'fallback', similarity: null, originalInput: trimmed };
};

const TYPE_COUNTERPARTS = {
  TRANSFER_OUT: 'TRANSFER_IN',
  TRANSFER_IN: 'TRANSFER_OUT',
};

const normalizeType = (type) => {
  if (!type || typeof type !== 'string') return null;
  return type.trim().toUpperCase();
};

const typesMatch = (userType, exchangeType) => {
  if (!userType || !exchangeType) return false;
  if (userType === exchangeType) return true;
  return TYPE_COUNTERPARTS[userType] === exchangeType;
};

module.exports = {
  normalizeAsset,
  normalizeType,
  typesMatch,
  levenshteinDistance,
  normalizedSimilarity,
  FUZZY_SIMILARITY_THRESHOLD,
};
