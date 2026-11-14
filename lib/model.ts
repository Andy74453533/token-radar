// Launch Radar v2: the valuation model behind the token-radar-01 entry.
//
// The board ranks protocols that record no token yet, by what a token would
// be worth if the protocol's record stayed as it is. Nothing here names a
// protocol: every number is fitted from the sealed snapshot itself, and the
// fit is backtested against the protocols whose token already trades.
//
// How the implied value is built:
//
//   1. A robust power law. Over the snapshot's live protocols (a positive
//      market cap and a positive TVL), least squares fits
//      log10(mcap) = intercept + slope * log10(TVL). One round of trimming
//      drops residuals past two standard deviations and the line is refit,
//      so a handful of absurd ratios cannot bend the curve. The slope lands
//      well under 1: the live market prices large protocols at a lower
//      market-cap-to-TVL ratio than small ones, and the curve says so.
//   2. Shrunk category offsets. Each category's mean residual from the
//      curve is shrunk toward zero by n / (n + prior), so a category with
//      one live member barely moves its protocols and a deep category earns
//      its offset. A category with no live member gets no offset.
//   3. Growth. The 7-day TVL change, clamped to [-30%, +50%], moves the
//      value at weight 0.15: a protocol growing into its launch is worth
//      more than one shrinking away from it, but the clamp keeps one wild
//      week from deciding anything.
//   4. Seasoning. Days since DefiLlama began tracking the protocol, capped
//      at 1095 days, move the value by at most +/-5% around the midpoint:
//      a longer-running protocol with no token yet has a longer record
//      behind the same TVL. An unknown listing date counts as 365 days.
//
//   implied_value_usd = round(10 ^ (intercept + slope*log10(TVL) + offset
//                              + log10(growthFactor) + log10(ageFactor))),
//   at least $1. Rows sort by implied value, ties by slug.
//
// The program backtests the whole pipeline at run time: leave-one-out over
// the live set, refitting the curve and the offsets on every fold, and
// reports the error beside a naive baseline (the snapshot-wide median
// market-cap-to-TVL ratio times TVL). The dashboard publishes the fitted
// parameters, the offsets and the backtest, and recomputes every row's
// value in the page from the same formulas, so the screenshots, the board
// and the code agree.

/** One protocol record, exactly the ten fields the sealed snapshot carries. */
export interface Proto {
  slug: string;
  name: string;
  category: string | null;
  chains: string[];
  tvl_usd: number;
  change_7d: number | null;
  mcap_usd: number | null;
  listed_at: string | null;
  gecko_id: string | null;
  symbol: string | null;
}

/** The sealed snapshot document. */
export interface Snap {
  as_of: string;
  source: string;
  floor_usd: number;
  protocols: Proto[];
  watchlist: string[];
}

/** One category's offset from the fitted curve, shrunk toward zero. */
export interface OffsetRow {
  category: string;
  offset: number;
  offset_factor: number;
  live_count: number;
  raw_offset: number;
}

/** The fitted model: the curve, its offsets, and how well it fits. */
export interface Fit {
  intercept: number;
  slope: number;
  live_count: number;
  kept_count: number;
  trimmed_count: number;
  r_squared: number;
  resid_sd: number;
  offsets: OffsetRow[];
}

/** Leave-one-out backtest over the live set, against a naive baseline. */
export interface Backtest {
  n: number;
  mae_log: number;
  median_log: number;
  median_pct: number;
  within_2x: number;
  within_3x: number;
  baseline_mae_log: number;
  baseline_median_pct: number;
  baseline_within_2x: number;
}

/** A live protocol priced against a board row: the nearest by TVL size. */
export interface Comparable {
  slug: string;
  name: string;
  tvl_usd: number;
  mcap_usd: number;
  ratio: number;
  same_category: boolean;
}

/** Every factor behind one row's implied value, for the detail view. */
export interface Breakdown {
  curve_value: number;
  offset: number;
  offset_factor: number;
  growth_pct: number;
  growth_factor: number;
  age_factor: number;
}

/** A board.json row. Extra keys are allowed by the gate; the dashboard reads them too. */
export interface BoardRow {
  rank: number;
  slug: string;
  name: string;
  category: string | null;
  chains: string[];
  tvl_usd: number;
  change_7d: number | null;
  mcap_usd: number | null;
  listed_at: string | null;
  gecko_id: string | null;
  symbol: string | null;
  token_status: 'pre-token';
  watchlist: boolean;
  age_days: number | null;
  implied_value_usd: number;
  breakdown: Breakdown;
  comparables: Comparable[];
  farm_steps: string[];
}

/** A protocol whose token already trades: shown apart, with the market's own value. */
export interface LiveEntry {
  slug: string;
  name: string;
  category: string | null;
  chains: string[];
  tvl_usd: number;
  mcap_usd: number;
  change_7d: number | null;
  ratio: number;
}

/** One live point on the fit chart: TVL against market cap. */
export interface ScatterPoint {
  slug: string;
  name: string;
  category: string | null;
  tvl_usd: number;
  mcap_usd: number;
}

/** Everything the dashboard page renders. */
export interface DashData {
  as_of: string;
  source: string;
  floor_usd: number;
  model_name: string;
  tune: typeof TUNE;
  fit: Fit;
  backtest: Backtest;
  watchlist_size: number;
  board_size: number;
  early_size: number;
  live_size: number;
  pre_token_total: number;
  rows: BoardRow[];
  live: LiveEntry[];
  scatter: ScatterPoint[];
}

/** The model's tuning: all in one place so the dashboard can state it. */
export const TUNE = {
  shrink_prior: 6,
  trim_sd: 2,
  growth_floor: -30,
  growth_cap: 50,
  growth_weight: 0.15,
  age_cap_days: 1095,
  age_amplitude: 0.1,
  unknown_age_days: 365,
  board_rows: 198,
  live_rows: 24,
  comp_count: 3,
} as const;

export const MODEL_NAME = 'robust power-law fit v2';

/** Why a snapshot cannot be scored. */
export class SnapError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'SnapError';
  }
}

const DAY_MS = 86_400_000;
const LOG10 = Math.log10;
const clamp = (v: number, lo: number, hi: number): number => Math.min(hi, Math.max(lo, v));
const round4 = (n: number): number => Math.round(n * 10_000) / 10_000;

/** The median of a non-empty list of numbers. */
function median(values: number[]): number {
  const s = [...values].sort((a, b) => a - b);
  const mid = Math.floor(s.length / 2);
  return s.length % 2 === 1 ? s[mid]! : (s[mid - 1]! + s[mid]!) / 2;
}

/** Least squares for y = a + b*x over paired points. */
function leastSquares(xs: number[], ys: number[]): { intercept: number; slope: number } {
  const n = xs.length;
  const mx = xs.reduce((s, v) => s + v, 0) / n;
  const my = ys.reduce((s, v) => s + v, 0) / n;
  let sxy = 0;
  let sxx = 0;
  for (let i = 0; i < n; i++) {
    sxy += (xs[i]! - mx) * (ys[i]! - my);
    sxx += (xs[i]! - mx) * (xs[i]! - mx);
  }
  const slope = sxx === 0 ? 0 : sxy / sxx;
  return { intercept: my - slope * mx, slope };
}

/** Whole days from `listed` to the snapshot date, clamped at zero; null when unparseable. */
export function ageInDays(asOf: string, listed: string | null): number | null {
  if (listed === null) return null;
  const a = Date.parse(`${asOf}T00:00:00Z`);
  const b = Date.parse(`${listed}T00:00:00Z`);
  if (!Number.isFinite(a) || !Number.isFinite(b)) return null;
  return Math.max(0, Math.floor((a - b) / DAY_MS));
}

/** A protocol records no token when all three token fields are empty. */
export function isPreToken(p: Proto): boolean {
  return p.mcap_usd === null && p.gecko_id === null && p.symbol === null;
}

/** The calibration set: live protocols with a positive market cap and TVL. */
export function calibrationSet(snap: Snap): Proto[] {
  return snap.protocols.filter((p) => p.mcap_usd !== null && p.mcap_usd > 0 && p.tvl_usd > 0);
}

/** Names ending in a version marker are pools of another protocol, not standalone launches. */
const VERSION_TAIL = /\s(V\d+(\.\d+)?|v\d+(\.\d+)?|\d+\.\d+)$/;

/**
 * Categories whose products are, by definition, wrapped, staked or bridged
 * forms of something else: the house's own watchlist rule leaves them out,
 * and the early set follows the same rule. A wrapped or staked product of a
 * token that already trades is not a token that does not exist yet.
 */
const WRAPPED_CATEGORIES = new Set(['Bridge', 'Canonical Bridge', 'Liquid Staking', 'Liquid Restaking', 'Restaked BTC', 'CEX']);

/** A name carrying a whole word wrapped, staked or staking names a wrapped product. */
const WRAPPED_WORD = /\b(wrapped|staked|staking)\b/i;

/** Exchange names: a name beginning with one is the exchange's own product. */
const EXCHANGE_PREFIX = /^(binance|coinbase|bybit|kraken|bitget|okx|bitfinex|gemini)\b/i;

/**
 * Whether a pre-token protocol may join the board below the watchlist
 * floor: it records no token, and it is not a wrapped, staked or bridged
 * product under the house rule's own tests (category, name words, exchange
 * prefix, version tail). The watchlist's own slugs are always included
 * regardless; this gate is for the early finds only.
 */
export function isEarlyCandidate(p: Proto): boolean {
  return (
    isPreToken(p) &&
    !WRAPPED_CATEGORIES.has(p.category ?? '') &&
    !WRAPPED_WORD.test(p.name) &&
    !EXCHANGE_PREFIX.test(p.name) &&
    !VERSION_TAIL.test(p.name)
  );
}

// ---------------------------------------------------------------- the fit

/** The curve plus its shrunk category offsets, fitted on one training set. */
export interface CurveFit {
  intercept: number;
  slope: number;
  kept: Proto[];
  trimmed: number;
  offsets: Map<string, number>;
}

/**
 * Fit the robust power law on a training set: least squares on
 * log10(mcap) against log10(TVL), one round of trimming past TUNE.trim_sd
 * residual standard deviations, then a refit on what survives. Category
 * offsets are the kept set's mean residual per category, shrunk toward
 * zero by n / (n + TUNE.shrink_prior). Pure and deterministic.
 */
export function fitCurve(train: Proto[]): CurveFit {
  const xs = train.map((p) => LOG10(p.tvl_usd));
  const ys = train.map((p) => LOG10(p.mcap_usd!));
  const first = leastSquares(xs, ys);
  const residuals = train.map((p, i) => ys[i]! - (first.intercept + first.slope * xs[i]!));
  const sd = Math.sqrt(residuals.reduce((s, r) => s + r * r, 0) / Math.max(1, residuals.length));
  const kept = train.filter((_, i) => Math.abs(residuals[i]!) <= TUNE.trim_sd * sd);
  const use = kept.length >= 20 ? kept : train;
  const refit = leastSquares(
    use.map((p) => LOG10(p.tvl_usd)),
    use.map((p) => LOG10(p.mcap_usd!)),
  );
  const byCat = new Map<string, number[]>();
  for (const p of use) {
    const key = p.category ?? '(uncategorised)';
    const arr = byCat.get(key) ?? [];
    arr.push(LOG10(p.mcap_usd!) - (refit.intercept + refit.slope * LOG10(p.tvl_usd)));
    byCat.set(key, arr);
  }
  const offsets = new Map<string, number>();
  for (const [key, rs] of byCat) {
    const mean = rs.reduce((s, v) => s + v, 0) / rs.length;
    // Rounded here, once: scoring, the backtest and the dashboard's
    // recompute all read this same value, so the page's arithmetic and the
    // board's data agree to the dollar.
    offsets.set(key, round4(mean * (rs.length / (rs.length + TUNE.shrink_prior))));
  }
  return { intercept: refit.intercept, slope: refit.slope, kept: use, trimmed: train.length - use.length, offsets };
}

/** The full published fit: the curve, the offset table, and the fit quality. */
export function calibrateFit(live: Proto[]): Fit {
  const curve = fitCurve(live);
  const rows: OffsetRow[] = [];
  const cats = new Set<string>(live.map((p) => p.category ?? '(uncategorised)'));
  for (const cat of [...cats].sort()) {
    const members = live.filter((p) => (p.category ?? '(uncategorised)') === cat);
    const raw =
      members.reduce((s, p) => s + (LOG10(p.mcap_usd!) - (curve.intercept + curve.slope * LOG10(p.tvl_usd))), 0) /
      members.length;
    const offset = curve.offsets.get(cat) ?? 0;
    rows.push({
      category: cat,
      offset: round4(offset),
      offset_factor: round4(Math.pow(10, offset)),
      live_count: members.length,
      raw_offset: round4(raw),
    });
  }
  // Fit quality on the whole live set, offsets included: honest reporting,
  // measured on every live protocol including the trimmed ones.
  const meanY = live.reduce((s, p) => s + LOG10(p.mcap_usd!), 0) / live.length;
  let ssRes = 0;
  let ssTot = 0;
  for (const p of live) {
    const pred = curve.intercept + curve.slope * LOG10(p.tvl_usd) + (curve.offsets.get(p.category ?? '(uncategorised)') ?? 0);
    ssRes += (LOG10(p.mcap_usd!) - pred) * (LOG10(p.mcap_usd!) - pred);
    ssTot += (LOG10(p.mcap_usd!) - meanY) * (LOG10(p.mcap_usd!) - meanY);
  }
  return {
    intercept: curve.intercept,
    slope: curve.slope,
    live_count: live.length,
    kept_count: curve.kept.length,
    trimmed_count: curve.trimmed,
    r_squared: round4(ssTot === 0 ? 0 : 1 - ssRes / ssTot),
    resid_sd: round4(Math.sqrt(ssRes / live.length)),
    offsets: rows,
  };
}

/** The growth factor for one protocol: clamped 7-day change at TUNE's weight. */
export function growthFactor(p: Proto): { growth_pct: number; factor: number } {
  const raw = p.change_7d !== null && Number.isFinite(p.change_7d) ? p.change_7d : 0;
  const growthPct = clamp(raw, TUNE.growth_floor, TUNE.growth_cap);
  return { growth_pct: growthPct, factor: 1 + (growthPct / 100) * TUNE.growth_weight };
}

/** The seasoning factor: at most +/- amplitude around the age midpoint. */
export function ageFactor(ageDays: number | null): number {
  const used = ageDays ?? TUNE.unknown_age_days;
  const frac = Math.min(Math.max(used, 0), TUNE.age_cap_days) / TUNE.age_cap_days;
  return 1 + TUNE.age_amplitude * (frac - 0.5);
}

/** The offset a protocol's category earns (zero when its category has no live member). */
function offsetFor(p: Proto, curve: CurveFit): number {
  return curve.offsets.get(p.category ?? '(uncategorised)') ?? 0;
}

/** log10 of the implied value: the curve, the offset, growth and seasoning. */
export function predictLog(p: Proto, asOf: string, curve: CurveFit): { logValue: number; breakdown: Breakdown } {
  const curveValue = Math.pow(10, curve.intercept + curve.slope * LOG10(p.tvl_usd));
  const offset = offsetFor(p, curve);
  const { growth_pct, factor: gf } = growthFactor(p);
  const af = ageFactor(ageInDays(asOf, p.listed_at));
  const logValue = curve.intercept + curve.slope * LOG10(p.tvl_usd) + offset + LOG10(gf) + LOG10(af);
  return {
    logValue,
    breakdown: {
      curve_value: Math.round(curveValue),
      offset: round4(offset),
      offset_factor: round4(Math.pow(10, offset)),
      growth_pct,
      growth_factor: round4(gf),
      age_factor: round4(af),
    },
  };
}

/** The implied value in whole dollars, at least $1. */
export function impliedValue(p: Proto, asOf: string, curve: CurveFit): { implied: number; breakdown: Breakdown } {
  const { logValue, breakdown } = predictLog(p, asOf, curve);
  return { implied: Math.max(1, Math.round(Math.pow(10, logValue))), breakdown };
}

// ---------------------------------------------------------------- backtest

/**
 * Leave-one-out backtest over the live set: each protocol is held out, the
 * curve and offsets are refit on the rest, and the held-out market cap is
 * predicted from its TVL, growth and age alone. The baseline is the naive
 * model the fit must beat: the training set's median market-cap-to-TVL
 * ratio (each ratio capped at 2x) times TVL, with no adjustments.
 */
export function backtest(live: Proto[], asOf: string): Backtest {
  const errors: number[] = [];
  const baselineErrors: number[] = [];
  for (let i = 0; i < live.length; i++) {
    const held = live[i]!;
    const train = live.filter((_, j) => j !== i);
    const curve = fitCurve(train);
    const { logValue } = predictLog(held, asOf, curve);
    errors.push(LOG10(held.mcap_usd!) - logValue);
    const ratios = train.map((q) => Math.min(2, q.mcap_usd! / q.tvl_usd));
    const base = LOG10(held.tvl_usd * median(ratios));
    baselineErrors.push(LOG10(held.mcap_usd!) - base);
  }
  const abs = errors.map(Math.abs).sort((a, b) => a - b);
  const baseAbs = baselineErrors.map(Math.abs).sort((a, b) => a - b);
  const mae = abs.reduce((s, v) => s + v, 0) / abs.length;
  const med = median(abs);
  const baseMae = baseAbs.reduce((s, v) => s + v, 0) / baseAbs.length;
  const baseMed = median(baseAbs);
  return {
    n: live.length,
    mae_log: round4(mae),
    median_log: round4(med),
    median_pct: round4((Math.pow(10, med) - 1) * 100),
    within_2x: round4(errors.filter((e) => Math.abs(e) <= LOG10(2)).length / errors.length),
    within_3x: round4(errors.filter((e) => Math.abs(e) <= LOG10(3)).length / errors.length),
    baseline_mae_log: round4(baseMae),
    baseline_median_pct: round4((Math.pow(10, baseMed) - 1) * 100),
    baseline_within_2x: round4(baselineErrors.filter((e) => Math.abs(e) <= LOG10(2)).length / baselineErrors.length),
  };
}

// ---------------------------------------------------------------- comparables

/**
 * The live protocols a board row is priced against: the nearest by TVL size
 * in the same category first, filled from the nearest overall. Displayed in
 * the detail view as evidence; the value itself comes from the fitted
 * curve, never from these names.
 */
export function comparablesFor(p: Proto, live: Proto[]): Comparable[] {
  const target = LOG10(p.tvl_usd);
  const byDistance = (a: Proto, b: Proto): number =>
    Math.abs(LOG10(a.tvl_usd) - target) - Math.abs(LOG10(b.tvl_usd) - target) || (a.slug < b.slug ? -1 : 1);
  const same = live.filter((q) => q.category === p.category).sort(byDistance);
  const rest = live.filter((q) => q.category !== p.category).sort(byDistance);
  const picked = [...same, ...rest].slice(0, TUNE.comp_count);
  return picked.map((q) => ({
    slug: q.slug,
    name: q.name,
    tvl_usd: q.tvl_usd,
    mcap_usd: q.mcap_usd!,
    ratio: round4(q.mcap_usd! / q.tvl_usd),
    same_category: q.category === p.category,
  }));
}

// ---------------------------------------------------------------- farm plans

/** A deterministic pick from a list, stable across runs: FNV-1a over the slug. */
function pick<T>(items: readonly T[], seed: string, salt: number): T {
  let h = 0x811c9dc5;
  const s = `${seed}#${salt}`;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return items[Math.abs(h) % items.length]!;
}

/** Gas cost wording, from the protocol's first chain: mainnet costs more than L2s and alt-L1s. */
function gasWord(chain: string): { tx: string; weekly: string } {
  const c = chain.toLowerCase();
  if (c === 'ethereum') return { tx: 'about $6-12 of gas', weekly: 'about $8 of gas a week' };
  if (c.includes('solana') || c.includes('sui') || c.includes('aptos') || c.includes('near') || c.includes('sei'))
    return { tx: 'under $1 of network fees', weekly: 'under $1 of fees a week' };
  if (c.includes('bitcoin') || c.includes('tron') || c.includes('dogecoin'))
    return { tx: 'about $2-4 of network fees', weekly: 'about $3 of fees a week' };
  return { tx: 'about $1-3 of gas', weekly: 'about $2 of gas a week' };
}

/** The capital tier for one farm position, from the protocol's TVL. */
function capitalTier(tvl: number): number {
  if (tvl >= 5_000_000_000) return 250;
  if (tvl >= 1_000_000_000) return 150;
  if (tvl >= 100_000_000) return 100;
  return 50;
}

/** The hold window, from the protocol's age: younger protocols need longer proof. */
function holdWindow(age: number | null): number {
  if (age === null) return 30;
  if (age < 180) return 60;
  if (age < 365) return 45;
  return 30;
}

interface FarmBits {
  open: string;
  weekly: string;
  caution: string;
  close: string;
}

/**
 * The category's farming mechanics: what a farmer actually does in a
 * protocol built this way, and what to watch while doing it. Matched on the
 * snapshot's own category string, most specific first; nothing names a
 * protocol, and the fallback covers categories the snapshot has not shown.
 */
function farmBits(p: Proto, capital: number, chain: string): FarmBits {
  const c = (p.category ?? '').toLowerCase();
  const n = p.name;
  if (c.includes('risk curator') || c.includes('curator')) {
    return {
      open: `Allocate $${capital} of USDC across two or three of ${n}'s curator vaults on ${chain}, splitting between curators rather than putting it all with one.`,
      weekly: `Review each curator's allocation and yield once a week, and move a small amount toward the curator whose vaults are earning best.`,
      caution: `Curators rebalance the underlying markets, so check the vault's current allocation before adding more.`,
      close: `Withdraw from each vault through the protocol's own app and keep the allocation history for every curator used.`,
    };
  }
  if (c.includes('restak') || c.includes('anchor btc') || c.includes('decentralized btc')) {
    return {
      open: `Restake $${capital} of the liquid staking receipt through ${n} on ${chain}, pick an operator with a long uptime record, and hold the restaking receipt.`,
      weekly: `Check the operator's performance and the restaked services once a week, and redelegate a small amount if the operator's record slips.`,
      caution: `Restaked positions can be slashed by the services they secure, so never restake funds you cannot afford to lose.`,
      close: `Unstake through the protocol's own queue, wait out the withdrawal delay, and keep the receipt until the funds land.`,
    };
  }
  if (c.includes('liquid staking') || c.includes('staking pool') || c.includes('staking')) {
    return {
      open: `Stake $${capital} of the staking asset through ${n} on ${chain} and hold the liquid receipt token in the farm wallet.`,
      weekly: `Use the receipt token once a week in the protocol's own pools or a lending market, so the stake keeps working instead of sitting idle.`,
      caution: `The receipt token can trade below its peg in stressed markets, so check its price before selling rather than assuming par.`,
      close: `Unstake through the protocol's own queue and keep the receipt until the withdrawal lands.`,
    };
  }
  if (c.includes('basis')) {
    return {
      open: `Deposit $${capital} of USDC into ${n}'s delta-neutral strategy on ${chain}, which holds spot long and a perpetual short in equal size.`,
      weekly: `Check the funding rate and the hedge ratio once a week, and rebalance a small amount when the two legs drift apart.`,
      caution: `When funding turns negative the strategy pays rather than earns, so watch the rate before adding more.`,
      close: `Exit both legs through the protocol's own flow at the same time, so the position closes hedged, and keep the funding history.`,
    };
  }
  if (c.includes('cdp') || c.includes('collateral')) {
    return {
      open: `Lock $${capital} of collateral in ${n} on ${chain} and mint stablecoins against it at no more than half the allowed ratio.`,
      weekly: `Check the collateral ratio once a week and top it up or repay a little whenever the ratio drifts toward liquidation.`,
      caution: `A fast price drop can liquidate the position, so keep the ratio well above the minimum at all times.`,
      close: `Repay the minted stablecoins in full, unlock the collateral, and keep the mint and repay records.`,
    };
  }
  if (c.includes('uncollateralized') || c.includes('lend')) {
    return {
      open: `Supply $${capital} of USDC to ${n} on ${chain} and leave the deposit earning, then borrow a small amount against it to show both sides of the market.`,
      weekly: `Top up or rebalance the supply once a week and keep the borrow under half the borrowing limit.`,
      caution: `Borrowed assets accrue interest every block, so check the borrow rate before leaving a loan open for weeks.`,
      close: `Repay the borrow in full, withdraw the supply, and keep the receipt of every transaction.`,
    };
  }
  if (c.includes('dex') || c.includes('leveraged farm') || c.includes('farm')) {
    return {
      open: `Add $${capital} of liquidity to ${n}'s deepest pool on ${chain} and stake the LP receipt if the app offers a gauge.`,
      weekly: `Swap a small amount through ${n} once a week and re-center the range if the pool is concentrated, so the position keeps earning fees.`,
      caution: `Concentrated positions stop earning when the price leaves the range, so check the range before each weekly visit.`,
      close: `Remove the liquidity, unstake the receipt, and keep the record of fees earned.`,
    };
  }
  if (c.includes('bridge')) {
    return {
      open: `Bridge $${capital} of USDC into ${chain} through ${n} and hold the bridged funds in an app on the destination chain.`,
      weekly: `Bridge a small amount back or onward once a week so the route sees repeat use in both directions.`,
      caution: `Bridges settle at different speeds per route, so confirm the funds arrived before starting the next leg.`,
      close: `Bridge the funds back to the starting chain and keep both sides' transaction hashes.`,
    };
  }
  if (c.includes('perpetual') || c.includes('derivative') || c.includes('options')) {
    return {
      open: `Deposit $${capital} of USDC as margin on ${n} on ${chain} and open one small hedged position, sized so a bad week cannot liquidate it.`,
      weekly: `Place one small trade a week and keep the margin ratio well above liquidation, adding margin rather than hoping.`,
      caution: `Leverage cuts both ways: size every position so the maximum loss is money already budgeted for farming.`,
      close: `Close the position, withdraw the margin, and keep the trade history.`,
    };
  }
  if (c.includes('yield') || c.includes('allocator') || c.includes('liquidity manager') || c.includes('indexes') || c.includes('vault')) {
    return {
      open: `Deposit $${capital} into a ${n} vault on ${chain} and hold the vault shares, choosing the vault whose strategy the app documents best.`,
      weekly: `Deposit a small amount weekly and check whether a new vault or gauge opened that fits the same strategy.`,
      caution: `Vault strategies change their underlying markets, so read the current strategy note before each new deposit.`,
      close: `Redeem the vault shares through the protocol's own flow and keep the deposit and withdrawal records.`,
    };
  }
  if (c.includes('rwa') || c.includes('real world')) {
    return {
      open: `Complete ${n}'s own onboarding if it asks, then mint $${capital} of its yield-bearing asset on ${chain} and hold it in the farm wallet.`,
      weekly: `Check the asset's yield accrual and backing report weekly, and add a small amount when the mint window opens.`,
      caution: `Real-world assets redeem on the issuer's schedule, not instantly, so confirm the redemption window before sizing the position.`,
      close: `Redeem the asset through the protocol's own flow and keep the mint and redemption records.`,
    };
  }
  if (c.includes('stablecoin wrapper') || c.includes('dual-token') || c.includes('stablecoin')) {
    return {
      open: `Wrap $${capital} of the underlying stablecoin through ${n} on ${chain} and hold the wrapped receipt in the farm wallet.`,
      weekly: `Use the wrapped asset once a week in the protocol's own pools or lending markets, so the wrapper sees real use.`,
      caution: `Wrapped assets depend on the wrapper's backing, so check the backing ratio on the protocol's own page before adding more.`,
      close: `Unwrap through the protocol's own flow and keep the wrap and unwrap records.`,
    };
  }
  if (c.includes('prediction')) {
    return {
      open: `Fund the farm wallet with $${capital} and take one real position on ${n} on ${chain}, in a market whose resolution rule you have read.`,
      weekly: `Take one small position a week and follow the protocol's own seasons or leaderboards for new markets.`,
      caution: `Prediction markets resolve on their stated rule, not on what feels true, so read the rule before staking.`,
      close: `Exit open positions or let them resolve, withdraw the balance, and keep the position history.`,
    };
  }
  if (c.includes('insurance')) {
    return {
      open: `Buy $${capital} of cover from ${n} on ${chain} for a protocol you already use, and keep the policy active.`,
      weekly: `Check the policy weekly, confirm the covered protocol is still in scope, and renew before it lapses.`,
      caution: `Cover pays only on the policy's stated events, so read the exclusions before relying on it.`,
      close: `Let the policy run its term, then withdraw any unused premium through the app and keep the policy record.`,
    };
  }
  if (c.includes('payment') || c.includes('card')) {
    return {
      open: `Fund the farm wallet with $${capital} and route one real payment through ${n} on ${chain}, keeping the receipt.`,
      weekly: `Make one small payment a week through the protocol's own rails and keep a stable balance in the account between payments.`,
      caution: `Payment rails have their own settlement times, so confirm each payment landed before counting it.`,
      close: `Withdraw the remaining balance through the protocol's own flow and keep the payment history.`,
    };
  }
  if (c.includes('governance')) {
    return {
      open: `Acquire $${capital} of the governance asset through ${n} on ${chain}, delegate the voting power to an active delegate or to the farm wallet, and keep it delegated.`,
      weekly: `Vote on one live proposal a week, or confirm the delegate voted, and read the proposal text before voting.`,
      caution: `Delegated votes follow the delegate's choice, so review the delegate's record before and during the hold.`,
      close: `Undelegate, exit the position through the protocol's own flow, and keep the voting record.`,
    };
  }
  if (c.includes('privacy')) {
    return {
      open: `Deposit $${capital} into ${n}'s shielded pool on ${chain} from the farm wallet and keep the shielding receipt safe.`,
      weekly: `Make one small shielded transfer a week through the protocol's own app and keep the receipts offline.`,
      caution: `Shielded funds are only recoverable with the receipt, so back it up offline before depositing anything.`,
      close: `Unshield through the protocol's own flow and keep the deposit and withdrawal records.`,
    };
  }
  if (c.includes('chain')) {
    return {
      open: `Bridge $${capital} of USDC into ${n}'s chain and use it in one native app: provide liquidity on its main exchange or stake the native asset.`,
      weekly: `Make one on-chain action a week in the ecosystem's own apps and keep a balance on the chain between visits.`,
      caution: `New chains can halt or fork, so keep the farm budget small enough to survive a bad week.`,
      close: `Bridge the funds back out through the protocol's own route and keep the bridge receipts.`,
    };
  }
  if (c.includes('cedefi')) {
    return {
      open: `Deposit $${capital} of USDC into ${n} on ${chain} through its own app and note where custody sits for the deposit.`,
      weekly: `Check the position and the protocol's own custody disclosures once a week, and add a small amount only while the disclosures stay clear.`,
      caution: `Hybrid protocols mix exchange custody with on-chain positions, so know which part holds the funds before depositing more.`,
      close: `Withdraw through the protocol's own flow and keep the deposit and withdrawal records.`,
    };
  }
  if (c.includes('otc')) {
    return {
      open: `Fund the farm wallet with $${capital} and place one real order through ${n} on ${chain}, inside the size the order book shows.`,
      weekly: `Place one small order a week and keep the wallet funded so orders can fill without delay.`,
      caution: `Thin order books move on small sizes, so use limit orders rather than market orders.`,
      close: `Cancel open orders, withdraw the balance, and keep the order history.`,
    };
  }
  return {
    open: `Deposit $${capital} of USDC into ${n} on ${chain} and keep the position open, following the steps the protocol's own app lists.`,
    weekly: `Make one qualifying action a week: a deposit, a swap, a vote or a task the app lists.`,
    caution: `Read the protocol's own documentation before the first deposit, and never send funds to an address from a chat or a search ad.`,
    close: `Withdraw the position through the protocol's own app and keep every transaction hash.`,
  };
}

const WALLET_OPENERS = [
  'Open a fresh wallet that holds only the funds you plan to farm, and store its seed phrase offline on paper before funding it.',
  'Set aside a dedicated farm wallet, separate from savings, and back up its seed phrase offline before it receives anything.',
  'Create a new wallet only for this farm, fund it with exactly the farming budget, and keep the seed phrase off the device.',
] as const;

const POINTS_CHECKS = [
  'Open the protocol’s own points or rewards page from its official site and confirm the wallet shows activity before the season ends.',
  'Check the protocol’s own rewards dashboard through its official links and confirm each week’s activity was counted.',
  'Visit the protocol’s own points page via its official site and record the wallet’s standing for your farm log.',
] as const;

/** One farm step as the gate wants it: a single string, 20..600 chars, with cost and time. */
function stepLine(action: string, cost: string, time: string): string {
  let s = `${action} Cost: ${cost}. Time: ${time}.`;
  if (s.length > 600) s = `${s.slice(0, 597)}...`;
  return s;
}

/**
 * A protocol's farm plan: six steps derived from its category mechanics,
 * chains, TVL and age. Variant wording is picked by a hash of the slug, so
 * the same protocol always gets the same plan and no name is ever
 * special-cased.
 */
export function farmPlan(p: Proto, age: number | null): string[] {
  const chain = p.chains.length > 0 ? p.chains[0]! : 'its main chain';
  const gas = gasWord(chain);
  const capital = capitalTier(p.tvl_usd);
  const hold = holdWindow(age);
  const bits = farmBits(p, capital, chain);
  const opener = pick(WALLET_OPENERS, p.slug, 1);
  const points = pick(POINTS_CHECKS, p.slug, 2);
  const multi =
    p.chains.length > 1
      ? ` Repeat the position on a second chain the protocol runs on (${p.chains[1]}) with half the capital, so the wallet shows cross-chain use.`
      : '';
  return [
    stepLine(opener, 'under $3 of gas for the first transaction', '5 minutes'),
    stepLine(`${bits.open}${multi}`, `$${capital} of capital and ${gas.tx}`, '15 minutes to set up'),
    stepLine(`${bits.weekly} ${bits.caution}`, gas.weekly, '10 minutes a week'),
    stepLine(
      `Hold the position for at least ${hold} days so the activity spans more than one snapshot window.`,
      `the $${capital} stays in the position`,
      `${hold} days`,
    ),
    stepLine(points, 'no fee to check, and never pay anyone to claim', '10 minutes'),
    stepLine(`${bits.close} Write the wallet, the dates and every transaction in a farm log.`, 'nothing but the log', '5 minutes'),
  ];
}

// ---------------------------------------------------------------- board assembly

/** One scored protocol: the record plus its fitted value and evidence. */
export interface Scored {
  proto: Proto;
  implied: number;
  breakdown: Breakdown;
  comparables: Comparable[];
}

/** Score one protocol under the fitted model. Pure and deterministic. */
export function score(p: Proto, asOf: string, curve: CurveFit, live: Proto[]): Scored {
  const { implied, breakdown } = impliedValue(p, asOf, curve);
  return { proto: p, implied, breakdown, comparables: comparablesFor(p, live) };
}

/** The live-token set, by market cap: the market's own values, kept apart from the board. */
export function liveSet(snap: Snap): LiveEntry[] {
  return snap.protocols
    .filter((p) => !isPreToken(p) && p.mcap_usd !== null && p.category !== 'CEX')
    .sort((a, b) => b.mcap_usd! - a.mcap_usd! || b.tvl_usd - a.tvl_usd || (a.slug < b.slug ? -1 : 1))
    .slice(0, TUNE.live_rows)
    .map((p) => ({
      slug: p.slug,
      name: p.name,
      category: p.category,
      chains: p.chains,
      tvl_usd: p.tvl_usd,
      mcap_usd: p.mcap_usd!,
      change_7d: p.change_7d,
      ratio: round4(p.tvl_usd > 0 ? p.mcap_usd! / p.tvl_usd : 0),
    }));
}

/** Build the ranked board: every watchlist slug, plus the strongest early candidates. */
export function buildBoard(snap: Snap, curve: CurveFit, live: Proto[]): BoardRow[] {
  const bySlug = new Map(snap.protocols.map((p) => [p.slug, p]));
  const picked = new Map<string, Proto>();
  for (const slug of snap.watchlist) {
    const p = bySlug.get(slug);
    if (p !== undefined) picked.set(slug, p);
  }
  const early = snap.protocols
    .filter((p) => !picked.has(p.slug) && isEarlyCandidate(p))
    .map((p) => score(p, snap.as_of, curve, live))
    .sort((a, b) => b.implied - a.implied || (a.proto.slug < b.proto.slug ? -1 : 1))
    .slice(0, Math.max(0, TUNE.board_rows - picked.size));
  for (const s of early) picked.set(s.proto.slug, s.proto);

  const scored = [...picked.values()]
    .map((p) => score(p, snap.as_of, curve, live))
    .sort((a, b) => b.implied - a.implied || (a.proto.slug < b.proto.slug ? -1 : 1));
  const watch = new Set(snap.watchlist);
  return scored.map((s, i) => ({
    rank: i + 1,
    slug: s.proto.slug,
    name: s.proto.name,
    category: s.proto.category,
    chains: s.proto.chains,
    tvl_usd: s.proto.tvl_usd,
    change_7d: s.proto.change_7d,
    mcap_usd: s.proto.mcap_usd,
    listed_at: s.proto.listed_at,
    gecko_id: s.proto.gecko_id,
    symbol: s.proto.symbol,
    token_status: 'pre-token',
    watchlist: watch.has(s.proto.slug),
    age_days: ageInDays(snap.as_of, s.proto.listed_at),
    implied_value_usd: s.implied,
    breakdown: s.breakdown,
    comparables: s.comparables,
    farm_steps: farmPlan(s.proto, ageInDays(snap.as_of, s.proto.listed_at)),
  }));
}

/** Everything the dashboard renders, from one snapshot. */
export function buildAll(snap: Snap): { board: BoardRow[]; dash: DashData } {
  const live = calibrationSet(snap);
  const curve = fitCurve(live);
  const fit = calibrateFit(live);
  const test = backtest(live, snap.as_of);
  const board = buildBoard(snap, curve, live);
  const liveTab = liveSet(snap);
  const early = board.filter((r) => !r.watchlist).length;
  const scatter: ScatterPoint[] = live
    .map((p) => ({ slug: p.slug, name: p.name, category: p.category, tvl_usd: p.tvl_usd, mcap_usd: p.mcap_usd! }))
    .sort((a, b) => a.slug < b.slug ? -1 : 1);
  const dash: DashData = {
    as_of: snap.as_of,
    source: snap.source,
    floor_usd: snap.floor_usd,
    model_name: MODEL_NAME,
    tune: TUNE,
    fit,
    backtest: test,
    watchlist_size: snap.watchlist.length,
    board_size: board.length,
    early_size: early,
    live_size: liveTab.length,
    pre_token_total: snap.protocols.filter(isPreToken).length,
    rows: board,
    live: liveTab,
    scatter,
  };
  return { board, dash };
}

/** Parse and validate the snapshot text. */
export function parseSnapshot(text: string): Snap {
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch {
    throw new SnapError('snapshot is not valid JSON');
  }
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) throw new SnapError('snapshot is not a JSON object');
  const o = raw as Record<string, unknown>;
  if (typeof o.as_of !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(o.as_of)) throw new SnapError('snapshot has no as_of date');
  if (typeof o.source !== 'string') throw new SnapError('snapshot has no source string');
  if (typeof o.floor_usd !== 'number' || !Number.isSafeInteger(o.floor_usd) || o.floor_usd <= 0) throw new SnapError('snapshot has no floor_usd');
  if (!Array.isArray(o.protocols)) throw new SnapError('snapshot has no protocols array');
  if (!Array.isArray(o.watchlist) || o.watchlist.some((s) => typeof s !== 'string')) throw new SnapError('snapshot has no watchlist of slugs');
  const protocols: Proto[] = o.protocols.map((v, i) => {
    if (typeof v !== 'object' || v === null || Array.isArray(v)) throw new SnapError(`protocol ${i} is not an object`);
    const p = v as Record<string, unknown>;
    if (typeof p.slug !== 'string' || typeof p.name !== 'string' || typeof p.tvl_usd !== 'number' || !Number.isFinite(p.tvl_usd)) {
      throw new SnapError(`protocol ${i} lacks slug, name or TVL`);
    }
    const numOrNull = (x: unknown): number | null => (typeof x === 'number' && Number.isFinite(x) ? x : null);
    const strOrNull = (x: unknown): string | null => (typeof x === 'string' ? x : null);
    return {
      slug: p.slug,
      name: p.name,
      category: strOrNull(p.category),
      chains: Array.isArray(p.chains) ? p.chains.filter((c): c is string => typeof c === 'string') : [],
      tvl_usd: p.tvl_usd,
      change_7d: numOrNull(p.change_7d),
      mcap_usd: numOrNull(p.mcap_usd),
      listed_at: strOrNull(p.listed_at),
      gecko_id: strOrNull(p.gecko_id),
      symbol: strOrNull(p.symbol),
    };
  });
  return { as_of: o.as_of, source: o.source, floor_usd: o.floor_usd, protocols, watchlist: o.watchlist as string[] };
}

/** Why a board would fail the gate, or null when it is clean. */
export function boardProblem(board: BoardRow[], snap: Snap): string | null {
  const slugs = new Set(board.map((r) => r.slug));
  const missing = snap.watchlist.filter((s) => !slugs.has(s));
  if (missing.length > 0) return `missing ${missing.length} watchlist slugs: ${missing.slice(0, 5).join(', ')}`;
  if (board.length < 100) return `only ${board.length} rows, the gate needs at least 100`;
  const ranks = board.map((r) => r.rank).sort((a, b) => a - b);
  for (let i = 0; i < ranks.length; i++) if (ranks[i] !== i + 1) return `ranks are not exactly 1..N (position ${i + 1} holds ${ranks[i]})`;
  for (let i = 1; i < board.length; i++) {
    if (board[i]!.implied_value_usd > board[i - 1]!.implied_value_usd) return `implied value rises from rank ${i} to rank ${i + 1}`;
  }
  if (board.length >= 2 && board.every((r) => r.implied_value_usd === board[0]!.implied_value_usd)) return 'all implied values are identical';
  const known = new Set(snap.protocols.map((p) => p.slug));
  for (const r of board) {
    if (!known.has(r.slug)) return `unknown slug ${r.slug}`;
    if (r.name.trim() === '') return `empty name for ${r.slug}`;
    if (!Number.isSafeInteger(r.implied_value_usd) || r.implied_value_usd <= 0) return `bad implied value for ${r.slug}`;
    if (r.farm_steps.length < 3 || r.farm_steps.length > 12) return `${r.slug} has ${r.farm_steps.length} farm steps`;
    for (const s of r.farm_steps) {
      const t = s.trim();
      if (t.length < 20 || t.length > 600) return `${r.slug} has a farm step of ${t.length} characters`;
    }
  }
  return null;
}

/** The dashboard's dataset as one script tag's worth of JavaScript. */
export function dataScript(dash: DashData): string {
  return `window.RADAR=${JSON.stringify(dash)};\n`;
}
