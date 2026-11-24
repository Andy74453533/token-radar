// Launch Radar v5 — rewritten model: the token-radar-01 valuation, backtest,
// board and farm plans.
//
// What this file does, in one paragraph: it fits a power law through the
// snapshot's own live protocols — log10(market cap) on log10(TVL), one
// round of 2-SD trimming, per-category offsets shrunk toward zero — then
// prices every pre-token protocol from the same formula, with a 50% and an
// 80% interval taken from the backtest's own errors. Alongside the shipped
// fit it runs a forty-five-way bake-off: every alternative is leave-one-out
// backtested on the same live set and compared to the shipped row by a
// paired t-test, Cohen's d, a 95% confidence interval and a fold-win share,
// so the choice to keep the simple curve is evidence, not taste. A stated
// selection rule decides whether any parameter variant ships; structural
// alternatives are reported but can never ship, because the dashboard
// recomputes every row from the published parameters and a shipped form it
// cannot re-derive would break that check.
//
// The board ranks the whole watchlist plus the remaining pre-token
// protocols that are not wrapped, staked or bridged products under the
// house rule. A trailing version marker alone never excludes a protocol —
// a V2 deployment is the protocol's current version — but when two versions
// of one family both qualify, only the larger TVL is ranked. Protocols
// whose snapshot record carries a token id or symbol but no market cap are
// neither ranked nor used to fit the curve: their tokens trade, the record
// just carries no price.
//
// Everything here is deterministic: no clock, no randomness, no network.
// Iteration is always in a sorted order, so the same snapshot always
// writes the same bytes.

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

export interface Snap {
  as_of: string;
  floor_usd: number;
  protocols: Proto[];
  watchlist: string[];
}

const MS_PER_DAY = 86_400_000;

/** Clamp v into [lo, hi]. */
const bound = (v: number, lo: number, hi: number): number => Math.min(hi, Math.max(lo, v));

/** The v4 knobs: the default the selection rule must beat before it moves. */
export const SHIP_SPEC = {
  shrinkPrior: 12,
  trimSd: 2,
  trimRounds: 1,
  growthWeight: 0.15,
  growthLo: -30,
  growthHi: 50,
  ageAmp: 0.1,
  ageCapDays: 1095,
  unknownAgeDays: 365,
} as const;

export interface Params {
  shrinkPrior: number;
  trimSd: number;
  trimRounds: number;
  growthWeight: number;
  ageAmp: number;
}

/** Parse the snapshot JSON and check its shape; throws on anything odd. */
export function parseSnapshot(text: string): Snap {
  const raw: unknown = JSON.parse(text);
  if (typeof raw !== 'object' || raw === null) throw new Error('snapshot is not an object');
  const root = raw as Record<string, unknown>;
  if (typeof root.as_of !== 'string') throw new Error('snapshot as_of is not a string');
  if (!Array.isArray(root.protocols)) throw new Error('snapshot protocols is not an array');
  if (!Array.isArray(root.watchlist)) throw new Error('snapshot watchlist is not an array');
  const protocols: Proto[] = root.protocols.map((item: unknown, i: number) => {
    if (typeof item !== 'object' || item === null) throw new Error(`protocol ${i} is not an object`);
    const q = item as Record<string, unknown>;
    const needText = (k: string): string => {
      if (typeof q[k] !== 'string') throw new Error(`protocol ${i} field ${k} is not a string`);
      return q[k] as string;
    };
    const needNumNull = (k: string): number | null => {
      if (q[k] === null) return null;
      if (typeof q[k] === 'number' && Number.isFinite(q[k])) return q[k] as number;
      throw new Error(`protocol ${i} field ${k} is not a finite number or null`);
    };
    const needTextNull = (k: string): string | null => {
      if (q[k] === null) return null;
      if (typeof q[k] === 'string') return q[k] as string;
      throw new Error(`protocol ${i} field ${k} is not a string or null`);
    };
    if (!Array.isArray(q.chains) || q.chains.some((c) => typeof c !== 'string')) {
      throw new Error(`protocol ${i} chains is not a string array`);
    }
    if (typeof q.tvl_usd !== 'number' || !Number.isFinite(q.tvl_usd)) {
      throw new Error(`protocol ${i} tvl_usd is not finite`);
    }
    return {
      slug: needText('slug'),
      name: needText('name'),
      category: needTextNull('category'),
      chains: [...(q.chains as string[])],
      tvl_usd: q.tvl_usd as number,
      change_7d: needNumNull('change_7d'),
      mcap_usd: needNumNull('mcap_usd'),
      listed_at: needTextNull('listed_at'),
      gecko_id: needTextNull('gecko_id'),
      symbol: needTextNull('symbol'),
    };
  });
  return {
    as_of: root.as_of as string,
    floor_usd: typeof root.floor_usd === 'number' ? root.floor_usd : 50_000_000,
    protocols,
    watchlist: root.watchlist.map((w) => String(w)),
  };
}

/** Whole days from first tracking to the snapshot date, or null when unlisted. */
export function daysListed(p: Proto, asOfMs: number): number | null {
  if (p.listed_at === null) return null;
  const t = Date.parse(`${p.listed_at}T00:00:00Z`);
  if (!Number.isFinite(t)) return null;
  return Math.max(0, Math.floor((asOfMs - t) / MS_PER_DAY));
}

/** Seven-day TVL growth as a clamped fraction: [-30%, +50%], unreported = 0. */
export function growthFraction(p: Proto): number {
  return bound(p.change_7d ?? 0, SHIP_SPEC.growthLo, SHIP_SPEC.growthHi) / 100;
}

/** Seasoning fraction: 0 at listing, 1 at three years, unknown age = 1 year. */
export function seasonFraction(p: Proto, asOfMs: number): number {
  const a = daysListed(p, asOfMs) ?? SHIP_SPEC.unknownAgeDays;
  return bound(a, 0, SHIP_SPEC.ageCapDays) / SHIP_SPEC.ageCapDays;
}

/** The category key the offsets use; null becomes the uncategorised bucket. */
export function categoryOf(p: Proto): string {
  return p.category ?? '(uncategorised)';
}

// ---------------------------------------------------------------- small stats

function medianOf(values: number[]): number {
  const s = [...values].sort((a, b) => a - b);
  const m = Math.floor(s.length / 2);
  return s.length % 2 === 1 ? s[m]! : (s[m - 1]! + s[m]!) / 2;
}

function quantileOf(sortedAsc: number[], q: number): number {
  if (sortedAsc.length === 0) return 0;
  const i = bound(Math.floor(q * sortedAsc.length), 0, sortedAsc.length - 1);
  return sortedAsc[i]!;
}

/** Dot product of two equal-length vectors, summed left to right. */
function dot(row: number[], beta: number[]): number {
  let s = 0;
  for (let j = 0; j < row.length; j++) s += row[j]! * beta[j]!;
  return s;
}

/** Ordinary least squares for y = a + b*x. Returns [intercept, slope]. */
export function olsLine(xs: number[], ys: number[]): [number, number] {
  const n = xs.length;
  const mx = xs.reduce((s, v) => s + v, 0) / n;
  const my = ys.reduce((s, v) => s + v, 0) / n;
  let sxy = 0;
  let sxx = 0;
  for (let i = 0; i < n; i++) {
    sxy += (xs[i]! - mx) * (ys[i]! - my);
    sxx += (xs[i]! - mx) * (xs[i]! - mx);
  }
  const b = sxx === 0 ? 0 : sxy / sxx;
  return [my - b * mx, b];
}

/** Weighted least squares for y = a + b*x. Returns [intercept, slope]. */
export function weightedOlsLine(xs: number[], ys: number[], ws: number[]): [number, number] {
  const sw = ws.reduce((s, v) => s + v, 0);
  const mx = xs.reduce((s, v, i) => s + ws[i]! * v, 0) / sw;
  const my = ys.reduce((s, v, i) => s + ws[i]! * v, 0) / sw;
  let sxy = 0;
  let sxx = 0;
  for (let i = 0; i < xs.length; i++) {
    sxy += ws[i]! * (xs[i]! - mx) * (ys[i]! - my);
    sxx += ws[i]! * (xs[i]! - mx) * (xs[i]! - mx);
  }
  const b = sxx === 0 ? 0 : sxy / sxx;
  return [my - b * mx, b];
}

/** Small dense solve: (A + ridge*I) x = b, Gauss-Jordan with pivoting. */
export function solveSystem(A: number[][], b: number[], ridge = 1e-8): number[] {
  const n = b.length;
  const M = A.map((row, i) => [...row, b[i]!]);
  for (let i = 0; i < n; i++) M[i]![i]! += ridge;
  for (let col = 0; col < n; col++) {
    let piv = col;
    for (let r = col + 1; r < n; r++) if (Math.abs(M[r]![col]!) > Math.abs(M[piv]![col]!)) piv = r;
    [M[col], M[piv]] = [M[piv]!, M[col]!];
    const d = M[col]![col]! || 1e-12;
    for (let r = 0; r < n; r++) {
      if (r === col) continue;
      const f = M[r]![col]! / d;
      for (let k = col; k <= n; k++) M[r]![k]! -= f * M[col]![k]!;
    }
  }
  return M.map((row, i) => row[n]! / (row[i]! || 1e-12));
}

/** OLS on a design matrix: solve (X'X) beta = X'y. */
export function olsDesign(rows: number[][], ys: number[]): number[] {
  const k = rows[0]!.length;
  const A = Array.from({ length: k }, () => Array(k).fill(0));
  const b = Array(k).fill(0);
  for (let i = 0; i < rows.length; i++) {
    for (let a = 0; a < k; a++) {
      b[a] += rows[i]![a]! * ys[i]!;
      for (let c = 0; c < k; c++) A[a]![c]! += rows[i]![a]! * rows[i]![c]!;
    }
  }
  return solveSystem(A, b);
}

/** Weighted OLS on a design matrix: solve (X'WX) beta = X'Wy. */
export function weightedDesignSolve(rows: number[][], ys: number[], ws: number[]): number[] {
  const k = rows[0]!.length;
  const A = Array.from({ length: k }, () => Array(k).fill(0));
  const b = Array(k).fill(0);
  for (let i = 0; i < rows.length; i++) {
    for (let a = 0; a < k; a++) {
      b[a] += ws[i]! * rows[i]![a]! * ys[i]!;
      for (let c = 0; c < k; c++) A[a]![c]! += ws[i]! * rows[i]![a]! * rows[i]![c]!;
    }
  }
  return solveSystem(A, b);
}

/**
 * Shrunk per-category offsets from design residuals: each category's mean
 * residual, pulled toward zero by n / (n + prior), so a category with one
 * live member barely moves its protocols and a deep one earns its offset.
 */
export function designOffsets(
  X: number[][],
  y: number[],
  beta: number[],
  cats: string[],
  prior: number,
): Map<string, number> {
  const groups = new Map<string, number[]>();
  X.forEach((row, i) => {
    const resid = y[i]! - dot(row, beta);
    const k = cats[i]!;
    if (!groups.has(k)) groups.set(k, []);
    groups.get(k)!.push(resid);
  });
  const out = new Map<string, number>();
  for (const [k, rs] of groups) {
    const mean = rs.reduce((s, v) => s + v, 0) / rs.length;
    out.set(k, mean * (rs.length / (rs.length + prior)));
  }
  return out;
}

// ---------------------------------------------------------------- the fit

export interface Fit {
  intercept: number;
  slope: number;
  r2: number;
  residSD: number;
  kept: number;
  trimmed: number;
  liveN: number;
  catOffsets: Map<string, number>;
  liveByCat: Map<string, number>;
  trimmedSlugs: string[];
}

/** Category offsets from a residual function, shrunk toward zero. */
function shrunkCategoryOffsets(
  items: Proto[],
  residOf: (p: Proto) => number,
  prior: number,
): Map<string, number> {
  const groups = new Map<string, number[]>();
  for (const p of items) {
    const k = categoryOf(p);
    if (!groups.has(k)) groups.set(k, []);
    groups.get(k)!.push(residOf(p));
  }
  const out = new Map<string, number>();
  for (const [k, rs] of groups) {
    const mean = rs.reduce((s, v) => s + v, 0) / rs.length;
    out.set(k, mean * (rs.length / (rs.length + prior)));
  }
  return out;
}

/**
 * The trimmed power law plus shrunk per-category offsets, at given knobs.
 * Each round fits the line, drops the residuals past trimSd standard
 * deviations, and refits; the last round's fit is the one that ships.
 */
export function fitCurve(
  live: Proto[],
  prior = SHIP_SPEC.shrinkPrior,
  trimSd = SHIP_SPEC.trimSd,
  rounds = SHIP_SPEC.trimRounds,
): Fit {
  let use = live;
  let a = 0;
  let b = 0;
  for (let round = 0; round <= rounds; round++) {
    [a, b] = olsLine(
      use.map((p) => Math.log10(p.tvl_usd)),
      use.map((p) => Math.log10(p.mcap_usd!)),
    );
    if (round === rounds) break;
    const res = use.map((p) => Math.log10(p.mcap_usd!) - (a + b * Math.log10(p.tvl_usd)));
    const sd = Math.sqrt(res.reduce((s, v) => s + v * v, 0) / res.length);
    const kept = use.filter((_, i) => Math.abs(res[i]!) <= trimSd * sd);
    if (kept.length < 20 || kept.length === use.length) break;
    use = kept;
  }
  const keptSet = new Set(use.map((p) => p.slug));
  const catOffsets = shrunkCategoryOffsets(
    use,
    (p) => Math.log10(p.mcap_usd!) - (a + b * Math.log10(p.tvl_usd)),
    prior,
  );
  const liveByCat = new Map<string, number>();
  for (const p of live) liveByCat.set(categoryOf(p), (liveByCat.get(categoryOf(p)) ?? 0) + 1);
  // R-squared and residual SD of the final curve on the kept set.
  const my = use.reduce((s, p) => s + Math.log10(p.mcap_usd!), 0) / use.length;
  let ssTot = 0;
  let ssRes = 0;
  for (const p of use) {
    const r = Math.log10(p.mcap_usd!) - (a + b * Math.log10(p.tvl_usd));
    ssRes += r * r;
    ssTot += (Math.log10(p.mcap_usd!) - my) ** 2;
  }
  return {
    intercept: a,
    slope: b,
    r2: ssTot === 0 ? 0 : 1 - ssRes / ssTot,
    residSD: Math.sqrt(ssRes / Math.max(1, use.length - 2)),
    kept: use.length,
    trimmed: live.length - use.length,
    liveN: live.length,
    catOffsets,
    liveByCat,
    trimmedSlugs: live.filter((p) => !keptSet.has(p.slug)).map((p) => p.slug).sort(),
  };
}

export interface Breakdown {
  curveValue: number;
  offset: number;
  offsetFactor: number;
  growthPct: number | null;
  growthFactor: number;
  ageFactor: number;
  ageDays: number | null;
}

/**
 * The fitted log10 value plus every component, so the page can recompute
 * it from the published parameters. The addition order is the model's own:
 * curve, then offset, then growth, then seasoning.
 */
export function predictRow(
  fit: Fit,
  p: Proto,
  asOfMs: number,
  params: Params = {
    shrinkPrior: SHIP_SPEC.shrinkPrior,
    trimSd: SHIP_SPEC.trimSd,
    trimRounds: SHIP_SPEC.trimRounds,
    growthWeight: SHIP_SPEC.growthWeight,
    ageAmp: SHIP_SPEC.ageAmp,
  },
): { logValue: number; breakdown: Breakdown } {
  const offset = fit.catOffsets.get(categoryOf(p)) ?? 0;
  const growthFactor = 1 + growthFraction(p) * params.growthWeight;
  const ageFactor = 1 + params.ageAmp * (seasonFraction(p, asOfMs) - 0.5);
  const logValue =
    fit.intercept +
    fit.slope * Math.log10(p.tvl_usd) +
    offset +
    Math.log10(growthFactor) +
    Math.log10(ageFactor);
  return {
    logValue,
    breakdown: {
      curveValue: Math.round(Math.pow(10, fit.intercept + fit.slope * Math.log10(p.tvl_usd))),
      offset: Math.round(offset * 10000) / 10000,
      offsetFactor: Math.round(Math.pow(10, offset) * 10000) / 10000,
      growthPct: p.change_7d,
      growthFactor: Math.round(growthFactor * 10000) / 10000,
      ageFactor: Math.round(ageFactor * 10000) / 10000,
      ageDays: daysListed(p, asOfMs),
    },
  };
}

/** The implied value in whole dollars, clamped to the gate's range. */
export function valueUsd(fit: Fit, p: Proto, asOfMs: number, params?: Params): number {
  const { logValue } = predictRow(fit, p, asOfMs, params);
  return bound(Math.round(Math.pow(10, logValue)), 1, 100_000_000_000_000);
}

// ---------------------------------------------------------------- backtest

export interface ErrorStats {
  n: number;
  mae: number;
  median: number;
  medianPct: number;
  within2: number;
  within3: number;
}

export interface ErrorBands {
  q05: number;
  q10: number;
  q25: number;
  q50: number;
  q75: number;
  q90: number;
  q95: number;
  sd: number;
  mean: number;
}

/** Mean and median absolute error, and the shares priced within 2x and 3x. */
export function errorSummary(errs: number[]): ErrorStats {
  const abs = errs.map(Math.abs);
  const med = medianOf(abs);
  return {
    n: errs.length,
    mae: abs.reduce((s, v) => s + v, 0) / abs.length,
    median: med,
    medianPct: (Math.pow(10, med) - 1) * 100,
    within2: errs.filter((e) => Math.abs(e) <= Math.log10(2)).length / errs.length,
    within3: errs.filter((e) => Math.abs(e) <= Math.log10(3)).length / errs.length,
  };
}

/** Residual quantiles plus mean and SD, for the intervals and the note. */
export function errorBands(errs: number[]): ErrorBands {
  const s = [...errs].sort((a, b) => a - b);
  const mean = errs.reduce((a, b) => a + b, 0) / errs.length;
  return {
    q05: quantileOf(s, 0.05),
    q10: quantileOf(s, 0.1),
    q25: quantileOf(s, 0.25),
    q50: quantileOf(s, 0.5),
    q75: quantileOf(s, 0.75),
    q90: quantileOf(s, 0.9),
    q95: quantileOf(s, 0.95),
    sd: Math.sqrt(errs.reduce((a, e) => a + (e - mean) ** 2, 0) / errs.length),
    mean,
  };
}

/** Histogram of residuals in fixed 0.4-dex bins, for the research note. */
export function errorHistogram(errs: number[]): { bin: number; count: number }[] {
  const counts = new Map<number, number>();
  for (const e of errs) {
    const b = Math.floor(e / 0.4) * 0.4;
    const key = Math.round(b * 10) / 10;
    counts.set(key, (counts.get(key) ?? 0) + 1);
  }
  return [...counts.entries()].sort((a, b) => a[0] - b[0]).map(([bin, count]) => ({ bin, count }));
}

/**
 * How often the residual-quantile intervals actually hold out of sample:
 * the share of leave-one-out errors inside the 50% band (q25..q75) and the
 * 80% band (q10..q90). An honest interval covers about its own name.
 */
export function bandCoverage(
  errs: number[],
  bands: ErrorBands,
): { cover50: number; cover80: number } {
  const n = errs.length;
  return {
    cover50: errs.filter((e) => e >= bands.q25 && e <= bands.q75).length / n,
    cover80: errs.filter((e) => e >= bands.q10 && e <= bands.q90).length / n,
  };
}

type Predictor = (p: Proto) => number;
type FitFn = (train: Proto[]) => Predictor;

/** Leave-one-out errors for any fit function, refitting on every fold. */
export function looResiduals(fitFn: FitFn, live: Proto[]): number[] {
  const errs: number[] = [];
  for (let i = 0; i < live.length; i++) {
    const train = live.filter((_, j) => j !== i);
    const f = fitFn(train);
    errs.push(Math.log10(live[i]!.mcap_usd!) - f(live[i]!));
  }
  return errs;
}

/** A predictor from a fitted power law (the shipped family). */
export function powerLawFn(
  train: Proto[],
  asOfMs: number,
  prior = SHIP_SPEC.shrinkPrior,
  trimSd = SHIP_SPEC.trimSd,
  rounds = SHIP_SPEC.trimRounds,
  growthW = SHIP_SPEC.growthWeight,
  ageAmp = SHIP_SPEC.ageAmp,
): Predictor {
  const fit = fitCurve(train, prior, trimSd, rounds);
  const params: Params = { shrinkPrior: prior, trimSd, trimRounds: rounds, growthWeight: growthW, ageAmp };
  return (p: Proto) => predictRow(fit, p, asOfMs, params).logValue;
}

/** Age through log1p days: a concave alternative to the linear fraction. */
function logAgeFrac(p: Proto, asOfMs: number): number {
  const a = daysListed(p, asOfMs) ?? SHIP_SPEC.unknownAgeDays;
  return Math.log1p(Math.max(0, a)) / Math.log1p(SHIP_SPEC.ageCapDays);
}

// --- the bake-off candidates: every specification the research note reports ---

/** Joint OLS on TVL, growth, age and chains, with shrunk category offsets. */
function jointOlsFn(train: Proto[], asOfMs: number): Predictor {
  const X = train.map((p) => [
    1,
    Math.log10(p.tvl_usd),
    growthFraction(p),
    logAgeFrac(p, asOfMs),
    Math.log2(Math.max(1, p.chains.length)),
  ]);
  const y = train.map((p) => Math.log10(p.mcap_usd!));
  const beta = olsDesign(X, y);
  const offsets = designOffsets(X, y, beta, train.map(categoryOf), SHIP_SPEC.shrinkPrior);
  return (p: Proto) => {
    const x = [1, Math.log10(p.tvl_usd), growthFraction(p), logAgeFrac(p, asOfMs), Math.log2(Math.max(1, p.chains.length))];
    return dot(x, beta) + (offsets.get(categoryOf(p)) ?? 0);
  };
}

/** Per-category slopes, shrunk toward the pooled slope. */
function catSlopeFn(train: Proto[], asOfMs: number): Predictor {
  const base = powerLawFn(train, asOfMs);
  const fit = fitCurve(train);
  const slope = fit.slope;
  const xbar = train.reduce((s, p) => s + Math.log10(p.tvl_usd), 0) / train.length;
  const byCat = new Map<string, Proto[]>();
  for (const p of train) {
    if (!byCat.has(categoryOf(p))) byCat.set(categoryOf(p), []);
    byCat.get(categoryOf(p))!.push(p);
  }
  const slopes = new Map<string, number>();
  for (const [k, members] of byCat) {
    if (members.length >= 4) {
      const [, b] = olsLine(
        members.map((p) => Math.log10(p.tvl_usd)),
        members.map((p) => Math.log10(p.mcap_usd!)),
      );
      const w = members.length / (members.length + 8);
      slopes.set(k, w * b + (1 - w) * slope);
    } else slopes.set(k, slope);
  }
  return (p: Proto) => base(p) + ((slopes.get(categoryOf(p)) ?? slope) - slope) * (Math.log10(p.tvl_usd) - xbar);
}

/** Quadratic in log TVL, with shrunk category offsets. */
function quadraticFn(train: Proto[], asOfMs: number): Predictor {
  const X = train.map((p) => {
    const lx = Math.log10(p.tvl_usd);
    return [1, lx, lx * lx, growthFraction(p), logAgeFrac(p, asOfMs)];
  });
  const y = train.map((p) => Math.log10(p.mcap_usd!));
  const beta = olsDesign(X, y);
  const offsets = designOffsets(X, y, beta, train.map(categoryOf), SHIP_SPEC.shrinkPrior);
  return (p: Proto) => {
    const lx = Math.log10(p.tvl_usd);
    const x = [1, lx, lx * lx, growthFraction(p), logAgeFrac(p, asOfMs)];
    return dot(x, beta) + (offsets.get(categoryOf(p)) ?? 0);
  };
}

/** Median (L1) regression by iteratively reweighted least squares. */
function medianRegFn(train: Proto[], asOfMs: number): Predictor {
  const X = train.map((p) => [1, Math.log10(p.tvl_usd), growthFraction(p), logAgeFrac(p, asOfMs)]);
  const y = train.map((p) => Math.log10(p.mcap_usd!));
  let beta = olsDesign(X, y);
  for (let iter = 0; iter < 25; iter++) {
    const w = X.map((x, i) => 1 / Math.max(0.05, Math.abs(y[i]! - dot(x, beta))));
    const next = weightedDesignSolve(X, y, w);
    const move = Math.max(...next.map((v, i) => Math.abs(v - beta[i]!)));
    beta = next;
    if (move < 1e-6) break;
  }
  const offsets = designOffsets(X, y, beta, train.map(categoryOf), SHIP_SPEC.shrinkPrior);
  return (p: Proto) => {
    const x = [1, Math.log10(p.tvl_usd), growthFraction(p), logAgeFrac(p, asOfMs)];
    return dot(x, beta) + (offsets.get(categoryOf(p)) ?? 0);
  };
}

/** k-nearest neighbours on standardised TVL, growth and age, with a same-category bonus. */
function knnFn(train: Proto[], asOfMs: number, k = 8): Predictor {
  const feats = train.map((p) => [Math.log10(p.tvl_usd), growthFraction(p), logAgeFrac(p, asOfMs)]);
  const mu = [0, 1, 2].map((j) => feats.reduce((s, f) => s + f[j]!, 0) / feats.length);
  const sd = [0, 1, 2].map((j) => Math.sqrt(feats.reduce((s, f) => s + (f[j]! - mu[j]!) ** 2, 0) / feats.length) || 1);
  const Z = feats.map((f) => f.map((v, j) => (v - mu[j]!) / sd[j]!));
  return (p: Proto) => {
    const z = [Math.log10(p.tvl_usd), growthFraction(p), logAgeFrac(p, asOfMs)].map((v, j) => (v - mu[j]!) / sd[j]!);
    const ds = train
      .map((q, i) => {
        let d = 0;
        for (let j = 0; j < 3; j++) d += (Z[i]![j]! - z[j]!) ** 2;
        if (categoryOf(q) !== categoryOf(p)) d += 1.0;
        return { d, y: Math.log10(q.mcap_usd!) };
      })
      .sort((a, b) => a.d - b.d);
    const near = ds.slice(0, k);
    const wsum = near.reduce((s, n) => s + 1 / (0.1 + n.d), 0);
    return near.reduce((s, n) => s + n.y / (0.1 + n.d), 0) / wsum;
  };
}

/** Theil–Sen robust line: the median pairwise slope, median intercept. */
function theilSenFn(train: Proto[], asOfMs: number): Predictor {
  const xs = train.map((p) => Math.log10(p.tvl_usd));
  const ys = train.map((p) => Math.log10(p.mcap_usd!));
  const slopes: number[] = [];
  for (let i = 0; i < train.length; i++) {
    for (let j = i + 1; j < train.length; j++) {
      if (xs[j] !== xs[i]) slopes.push((ys[j]! - ys[i]!) / (xs[j]! - xs[i]!));
    }
  }
  const b = medianOf(slopes);
  const a = medianOf(ys.map((yy, i) => yy - b * xs[i]!));
  const off = shrunkCategoryOffsets(train, (p) => Math.log10(p.mcap_usd!) - (a + b * Math.log10(p.tvl_usd)), SHIP_SPEC.shrinkPrior);
  return (p: Proto) =>
    a +
    b * Math.log10(p.tvl_usd) +
    (off.get(categoryOf(p)) ?? 0) +
    Math.log10(1 + growthFraction(p) * SHIP_SPEC.growthWeight) +
    Math.log10(1 + SHIP_SPEC.ageAmp * (seasonFraction(p, asOfMs) - 0.5));
}

/** Huber robust line: iteratively reweighted least squares with a 1.345c cutoff. */
function huberFn(train: Proto[], asOfMs: number): Predictor {
  const xs = train.map((p) => Math.log10(p.tvl_usd));
  const ys = train.map((p) => Math.log10(p.mcap_usd!));
  let [a, b] = olsLine(xs, ys);
  for (let iter = 0; iter < 30; iter++) {
    const res = xs.map((x, i) => ys[i]! - (a + b * x));
    const s = 1.4826 * medianOf(res.map(Math.abs)) || 1;
    const w = res.map((r) => Math.min(1, (1.345 * s) / Math.max(Math.abs(r), 1e-9)));
    const sw = w.reduce((x, y) => x + y, 0);
    const mx = xs.reduce((t, x, i) => t + w[i]! * x, 0) / sw;
    const my = ys.reduce((t, y, i) => t + w[i]! * y, 0) / sw;
    let sxy = 0;
    let sxx = 0;
    for (let i = 0; i < xs.length; i++) {
      sxy += w[i]! * (xs[i]! - mx) * (ys[i]! - my);
      sxx += w[i]! * (xs[i]! - mx) ** 2;
    }
    const nb = sxx === 0 ? 0 : sxy / sxx;
    const na = my - nb * mx;
    if (Math.abs(na - a) < 1e-8 && Math.abs(nb - b) < 1e-8) {
      a = na;
      b = nb;
      break;
    }
    a = na;
    b = nb;
  }
  const off = shrunkCategoryOffsets(train, (p) => Math.log10(p.mcap_usd!) - (a + b * Math.log10(p.tvl_usd)), SHIP_SPEC.shrinkPrior);
  return (p: Proto) =>
    a +
    b * Math.log10(p.tvl_usd) +
    (off.get(categoryOf(p)) ?? 0) +
    Math.log10(1 + growthFraction(p) * SHIP_SPEC.growthWeight) +
    Math.log10(1 + SHIP_SPEC.ageAmp * (seasonFraction(p, asOfMs) - 0.5));
}

/** The naive baseline: the median market-cap-to-TVL ratio, capped at 2. */
function naiveFn(train: Proto[]): Predictor {
  const r = medianOf(train.map((p) => Math.min(2, p.mcap_usd! / p.tvl_usd)));
  return (p: Proto) => Math.log10(p.tvl_usd * r);
}

export interface CandidateResult {
  name: string;
  shipped: boolean;
  /** True when this candidate is a power-law parameter variant: the only
      family the dashboard's recompute can verify, hence the only family
      the selection rule may ship. */
  paramFamily: boolean;
  summary: ErrorStats;
  /** Paired t-statistic of |error| against the shipped specification over
      the same folds: negative means the candidate errs less, positive means
      it errs more; null for the shipped row itself. |t| under 2 is noise. */
  pairedT: number | null;
  /** Cohen's d on the same paired differences: the size of the gap, not
      just whether it clears a threshold. Null for the shipped row. */
  cohensD: number | null;
  /** 95% confidence interval on the mean paired |error| difference
      (candidate minus shipped), in dex. Null for the shipped row. */
  ci95: [number, number] | null;
  /** Share of folds where the candidate's |error| beats the shipped row's.
      Null for the shipped row itself. A challenger can win on average
      while losing most folds, and this number shows which it is. */
  winShare: number | null;
}

/** The fitted log value with growth weight and seasoning amplitude as
    knobs, so the bake-off can test ablations and weight variants as honest
    refits. The shipped path never calls this: it uses predictRow and SHIP_SPEC. */
function predictWithKnobs(fit: Fit, p: Proto, asOfMs: number, growthW: number, ageAmp: number): number {
  const offset = fit.catOffsets.get(categoryOf(p)) ?? 0;
  return (
    fit.intercept +
    fit.slope * Math.log10(p.tvl_usd) +
    offset +
    Math.log10(1 + growthFraction(p) * growthW) +
    Math.log10(1 + ageAmp * (seasonFraction(p, asOfMs) - 0.5))
  );
}

/** A power-law predictor at arbitrary knobs, for the parameter variants. */
function paramFn(
  train: Proto[],
  asOfMs: number,
  opts: { prior?: number; trimSd?: number; rounds?: number; growthW?: number; ageAmp?: number } = {},
): Predictor {
  const fit = fitCurve(train, opts.prior ?? SHIP_SPEC.shrinkPrior, opts.trimSd ?? SHIP_SPEC.trimSd, opts.rounds ?? SHIP_SPEC.trimRounds);
  const growthW = opts.growthW ?? SHIP_SPEC.growthWeight;
  const ageAmp = opts.ageAmp ?? SHIP_SPEC.ageAmp;
  return (p: Proto) => predictWithKnobs(fit, p, asOfMs, growthW, ageAmp);
}

/** Median-residual category offsets instead of mean-residual ones: the
    robust alternative to the shipped shrinkage, tested and rejected. */
function medianOffsetFn(train: Proto[], asOfMs: number): Predictor {
  let use = train;
  let a = 0;
  let b = 0;
  for (let round = 0; round <= SHIP_SPEC.trimRounds; round++) {
    [a, b] = olsLine(
      use.map((p) => Math.log10(p.tvl_usd)),
      use.map((p) => Math.log10(p.mcap_usd!)),
    );
    if (round === SHIP_SPEC.trimRounds) break;
    const res = use.map((p) => Math.log10(p.mcap_usd!) - (a + b * Math.log10(p.tvl_usd)));
    const sd = Math.sqrt(res.reduce((s, v) => s + v * v, 0) / res.length);
    use = use.filter((_, i) => Math.abs(res[i]!) <= SHIP_SPEC.trimSd * sd);
  }
  const groups = new Map<string, number[]>();
  for (const p of use) {
    const k = categoryOf(p);
    if (!groups.has(k)) groups.set(k, []);
    groups.get(k)!.push(Math.log10(p.mcap_usd!) - (a + b * Math.log10(p.tvl_usd)));
  }
  const offsets = new Map<string, number>();
  for (const [k, rs] of groups) {
    const s = [...rs].sort((x, y) => x - y);
    const med = s.length % 2 === 1 ? s[(s.length - 1) / 2]! : (s[s.length / 2 - 1]! + s[s.length / 2]!) / 2;
    offsets.set(k, med * (rs.length / (rs.length + SHIP_SPEC.shrinkPrior)));
  }
  return (p: Proto) => {
    const offset = offsets.get(categoryOf(p)) ?? 0;
    return (
      a +
      b * Math.log10(p.tvl_usd) +
      offset +
      Math.log10(1 + growthFraction(p) * SHIP_SPEC.growthWeight) +
      Math.log10(1 + SHIP_SPEC.ageAmp * (seasonFraction(p, asOfMs) - 0.5))
    );
  };
}

// --- v5's new candidates: seventeen specifications v4 never tested ---

/** Joint OLS with a chains-count term: does breadth of deployment add signal? */
function chainsTermFn(train: Proto[], asOfMs: number): Predictor {
  const X = train.map((p) => [1, Math.log10(p.tvl_usd), Math.log2(Math.max(1, p.chains.length)), growthFraction(p), logAgeFrac(p, asOfMs)]);
  const y = train.map((p) => Math.log10(p.mcap_usd!));
  const beta = olsDesign(X, y);
  const offsets = designOffsets(X, y, beta, train.map(categoryOf), SHIP_SPEC.shrinkPrior);
  return (p: Proto) => {
    const x = [1, Math.log10(p.tvl_usd), Math.log2(Math.max(1, p.chains.length)), growthFraction(p), logAgeFrac(p, asOfMs)];
    return dot(x, beta) + (offsets.get(categoryOf(p)) ?? 0);
  };
}

/** Two-segment slope with the break at the median log TVL: does the curve bend with size? */
function piecewiseFn(train: Proto[], asOfMs: number): Predictor {
  const xs = train.map((p) => Math.log10(p.tvl_usd)).sort((a, b) => a - b);
  const br = xs[Math.floor(xs.length / 2)]!;
  const X = train.map((p) => {
    const lx = Math.log10(p.tvl_usd);
    return [1, lx, Math.max(0, lx - br), growthFraction(p), logAgeFrac(p, asOfMs)];
  });
  const y = train.map((p) => Math.log10(p.mcap_usd!));
  const beta = olsDesign(X, y);
  const offsets = designOffsets(X, y, beta, train.map(categoryOf), SHIP_SPEC.shrinkPrior);
  return (p: Proto) => {
    const lx = Math.log10(p.tvl_usd);
    const x = [1, lx, Math.max(0, lx - br), growthFraction(p), logAgeFrac(p, asOfMs)];
    return dot(x, beta) + (offsets.get(categoryOf(p)) ?? 0);
  };
}

/** Growth through log1p instead of the clamped linear fraction. */
function logGrowthFn(train: Proto[], asOfMs: number): Predictor {
  const fit = fitCurve(train);
  return (p: Proto) => {
    const offset = fit.catOffsets.get(categoryOf(p)) ?? 0;
    const g = Math.log1p(bound(p.change_7d ?? 0, SHIP_SPEC.growthLo, SHIP_SPEC.growthHi) / 100);
    return (
      fit.intercept +
      fit.slope * Math.log10(p.tvl_usd) +
      offset +
      g * SHIP_SPEC.growthWeight +
      Math.log10(1 + SHIP_SPEC.ageAmp * (seasonFraction(p, asOfMs) - 0.5))
    );
  };
}

/** Age through log1p days instead of the linear three-year fraction. */
function logAgeFn(train: Proto[], asOfMs: number): Predictor {
  const fit = fitCurve(train);
  return (p: Proto) => {
    const offset = fit.catOffsets.get(categoryOf(p)) ?? 0;
    return (
      fit.intercept +
      fit.slope * Math.log10(p.tvl_usd) +
      offset +
      Math.log10(1 + growthFraction(p) * SHIP_SPEC.growthWeight) +
      Math.log10(1 + SHIP_SPEC.ageAmp * (logAgeFrac(p, asOfMs) - 0.5))
    );
  };
}

/** Recency-weighted power law: protocols listed recently count more. */
function recencyFn(train: Proto[], asOfMs: number): Predictor {
  const xs = train.map((p) => Math.log10(p.tvl_usd));
  const ys = train.map((p) => Math.log10(p.mcap_usd!));
  const ws = train.map((p) => 1 / (1 + (daysListed(p, asOfMs) ?? SHIP_SPEC.unknownAgeDays) / 365));
  const [a, b] = weightedOlsLine(xs, ys, ws);
  const off = shrunkCategoryOffsets(train, (p) => Math.log10(p.mcap_usd!) - (a + b * Math.log10(p.tvl_usd)), SHIP_SPEC.shrinkPrior);
  return (p: Proto) =>
    a +
    b * Math.log10(p.tvl_usd) +
    (off.get(categoryOf(p)) ?? 0) +
    Math.log10(1 + growthFraction(p) * SHIP_SPEC.growthWeight) +
    Math.log10(1 + SHIP_SPEC.ageAmp * (seasonFraction(p, asOfMs) - 0.5));
}

/** TVL-weighted power law: large protocols count more in the fit. */
function tvlWeightedFn(train: Proto[], asOfMs: number): Predictor {
  const xs = train.map((p) => Math.log10(p.tvl_usd));
  const ys = train.map((p) => Math.log10(p.mcap_usd!));
  const lo = Math.min(...xs);
  const ws = xs.map((x) => 0.5 + (x - lo));
  const [a, b] = weightedOlsLine(xs, ys, ws);
  const off = shrunkCategoryOffsets(train, (p) => Math.log10(p.mcap_usd!) - (a + b * Math.log10(p.tvl_usd)), SHIP_SPEC.shrinkPrior);
  return (p: Proto) =>
    a +
    b * Math.log10(p.tvl_usd) +
    (off.get(categoryOf(p)) ?? 0) +
    Math.log10(1 + growthFraction(p) * SHIP_SPEC.growthWeight) +
    Math.log10(1 + SHIP_SPEC.ageAmp * (seasonFraction(p, asOfMs) - 0.5));
}

/** Joint OLS with a diminishing-returns term: log1p(TVL / $100M). */
function diminishingFn(train: Proto[], asOfMs: number): Predictor {
  const X = train.map((p) => [1, Math.log10(p.tvl_usd), Math.log1p(p.tvl_usd / 100_000_000), growthFraction(p), logAgeFrac(p, asOfMs)]);
  const y = train.map((p) => Math.log10(p.mcap_usd!));
  const beta = olsDesign(X, y);
  const offsets = designOffsets(X, y, beta, train.map(categoryOf), SHIP_SPEC.shrinkPrior);
  return (p: Proto) => {
    const x = [1, Math.log10(p.tvl_usd), Math.log1p(p.tvl_usd / 100_000_000), growthFraction(p), logAgeFrac(p, asOfMs)];
    return dot(x, beta) + (offsets.get(categoryOf(p)) ?? 0);
  };
}

/** Full interaction: per-category intercept AND slope, both shrunk to the pooled line. */
function catInterceptSlopeFn(train: Proto[], asOfMs: number): Predictor {
  const base = powerLawFn(train, asOfMs);
  const fit = fitCurve(train);
  const slope = fit.slope;
  const intercept = fit.intercept;
  const xbar = train.reduce((s, p) => s + Math.log10(p.tvl_usd), 0) / train.length;
  const byCat = new Map<string, Proto[]>();
  for (const p of train) {
    if (!byCat.has(categoryOf(p))) byCat.set(categoryOf(p), []);
    byCat.get(categoryOf(p))!.push(p);
  }
  const adj = new Map<string, { da: number; db: number }>();
  for (const [k, members] of byCat) {
    if (members.length >= 4) {
      const [a, b] = olsLine(
        members.map((p) => Math.log10(p.tvl_usd)),
        members.map((p) => Math.log10(p.mcap_usd!)),
      );
      const w = members.length / (members.length + 8);
      // The category line through the pooled centre, shrunk toward the pooled line.
      const da = w * (a + b * xbar - (intercept + slope * xbar));
      const db = w * (b - slope);
      adj.set(k, { da, db });
    } else adj.set(k, { da: 0, db: 0 });
  }
  return (p: Proto) => {
    const a = adj.get(categoryOf(p)) ?? { da: 0, db: 0 };
    return base(p) + a.da + a.db * (Math.log10(p.tvl_usd) - xbar);
  };
}

/** Huber line with per-category shrunk slopes on top of it. */
function huberSlopeFn(train: Proto[], asOfMs: number): Predictor {
  const base = huberFn(train, asOfMs);
  const xs = train.map((p) => Math.log10(p.tvl_usd));
  const xbar = xs.reduce((s, v) => s + v, 0) / xs.length;
  const [, pooledB] = olsLine(xs, train.map((p) => Math.log10(p.mcap_usd!)));
  const byCat = new Map<string, Proto[]>();
  for (const p of train) {
    if (!byCat.has(categoryOf(p))) byCat.set(categoryOf(p), []);
    byCat.get(categoryOf(p))!.push(p);
  }
  const slopes = new Map<string, number>();
  for (const [k, members] of byCat) {
    if (members.length >= 4) {
      const [, b] = olsLine(
        members.map((p) => Math.log10(p.tvl_usd)),
        members.map((p) => Math.log10(p.mcap_usd!)),
      );
      const w = members.length / (members.length + 8);
      slopes.set(k, w * b + (1 - w) * pooledB);
    } else slopes.set(k, pooledB);
  }
  return (p: Proto) => base(p) + ((slopes.get(categoryOf(p)) ?? pooledB) - pooledB) * (Math.log10(p.tvl_usd) - xbar);
}

export interface SplitRow {
  name: string;
  shipped: boolean;
  loo_mae: number;
  loco_mae: number;
  band_mae: number;
}

interface SpecEntry {
  name: string;
  shipped: boolean;
  paramFamily: boolean;
  fn: FitFn;
}

/** The bake-off specification list, shared by runBakeOff and hardSplits so
    both judge exactly the same fits. */
export function specTable(asOfMs: number): SpecEntry[] {
  const noOffsets = (train: Proto[]): Predictor => {
    const fit = fitCurve(train, 1e12, SHIP_SPEC.trimSd, SHIP_SPEC.trimRounds);
    return (p: Proto) => predictRow(fit, p, asOfMs).logValue;
  };
  const blend = (a: FitFn, b: FitFn, wa: number) => (train: Proto[]): Predictor => {
    const m1 = a(train);
    const m2 = b(train);
    return (p: Proto) => wa * m1(p) + (1 - wa) * m2(p);
  };
  const blend3 = (train: Proto[]): Predictor => {
    const m1 = powerLawFn(train, asOfMs);
    const m2 = huberFn(train, asOfMs);
    const m3 = knnFn(train, asOfMs);
    return (p: Proto) => (m1(p) + m2(p) + m3(p)) / 3;
  };
  const param = (name: string, opts: { prior?: number; trimSd?: number; rounds?: number; growthW?: number; ageAmp?: number }): SpecEntry => ({
    name,
    shipped: false,
    paramFamily: true,
    fn: (t) => paramFn(t, asOfMs, opts),
  });
  const structural = (name: string, fn: FitFn): SpecEntry => ({ name, shipped: false, paramFamily: false, fn });
  const power = (name: string, prior?: number, trimSd?: number, rounds?: number): SpecEntry => ({
    name,
    shipped: false,
    paramFamily: true,
    fn: (t) => powerLawFn(t, asOfMs, prior ?? SHIP_SPEC.shrinkPrior, trimSd ?? SHIP_SPEC.trimSd, rounds ?? SHIP_SPEC.trimRounds),
  });
  const shippedFn = (t: Proto[]): Predictor => powerLawFn(t, asOfMs);
  return [
    { name: 'Power law + shrunk offsets (prior 12) — shipped', shipped: true, paramFamily: true, fn: shippedFn },
    param('Power law + offsets, prior 4', { prior: 4 }),
    param('Power law + offsets, prior 6', { prior: 6 }),
    param('Power law + offsets, prior 8', { prior: 8 }),
    param('Power law + offsets, prior 16', { prior: 16 }),
    param('Power law + offsets, prior 20', { prior: 20 }),
    param('Power law + offsets, prior 24', { prior: 24 }),
    param('Power law + offsets, prior 32', { prior: 32 }),
    param('Power law, trim 1.5 SD', { trimSd: 1.5 }),
    param('Power law, trim 2.5 SD', { trimSd: 2.5 }),
    param('Power law, trim 3 SD', { trimSd: 3 }),
    param('Power law, trim 2 rounds', { rounds: 2 }),
    power('Power law, no trim', SHIP_SPEC.shrinkPrior, 1e9, 0),
    structural('Power law, no category offsets', noOffsets),
    structural('Power law, median category offsets', (t) => medianOffsetFn(t, asOfMs)),
    param('Power law, growth weight 0.10', { growthW: 0.1 }),
    param('Power law, growth weight 0.20', { growthW: 0.2 }),
    param('Power law, no growth factor', { growthW: 0 }),
    param('Power law, seasoning amp 0.05', { ageAmp: 0.05 }),
    param('Power law, seasoning amp 0.15', { ageAmp: 0.15 }),
    param('Power law, no seasoning factor', { ageAmp: 0 }),
    param('Power law, no growth or seasoning', { growthW: 0, ageAmp: 0 }),
    structural('Joint OLS: TVL + growth + age + chains', (t) => jointOlsFn(t, asOfMs)),
    structural('Joint OLS + chains-count term', (t) => chainsTermFn(t, asOfMs)),
    structural('Two-segment slope at median TVL', (t) => piecewiseFn(t, asOfMs)),
    structural('Joint OLS + diminishing-returns term', (t) => diminishingFn(t, asOfMs)),
    structural('Per-category slopes, shrunk', (t) => catSlopeFn(t, asOfMs)),
    structural('Per-category intercept + slope, shrunk', (t) => catInterceptSlopeFn(t, asOfMs)),
    structural('Quadratic in log TVL', (t) => quadraticFn(t, asOfMs)),
    structural('Median (L1) regression', (t) => medianRegFn(t, asOfMs)),
    structural('k-nearest neighbours (k = 4)', (t) => knnFn(t, asOfMs, 4)),
    structural('k-nearest neighbours (k = 8)', (t) => knnFn(t, asOfMs)),
    structural('k-nearest neighbours (k = 16)', (t) => knnFn(t, asOfMs, 16)),
    structural('Ensemble: power law + kNN', blend((t) => powerLawFn(t, asOfMs), (t) => knnFn(t, asOfMs), 0.5)),
    structural('Ensemble: power law + Huber', blend((t) => powerLawFn(t, asOfMs), (t) => huberFn(t, asOfMs), 0.5)),
    structural('Ensemble: power law + Theil-Sen', blend((t) => powerLawFn(t, asOfMs), (t) => theilSenFn(t, asOfMs), 0.5)),
    structural('Ensemble: power law + Huber + kNN', blend3),
    structural('Theil–Sen robust line', (t) => theilSenFn(t, asOfMs)),
    structural('Huber robust line', (t) => huberFn(t, asOfMs)),
    structural('Huber line + per-category slopes', (t) => huberSlopeFn(t, asOfMs)),
    structural('Growth through log1p(change)', (t) => logGrowthFn(t, asOfMs)),
    structural('Age through log1p(days)', (t) => logAgeFn(t, asOfMs)),
    structural('Recency-weighted power law', (t) => recencyFn(t, asOfMs)),
    structural('TVL-weighted power law', (t) => tvlWeightedFn(t, asOfMs)),
    structural('Naive: median mcap/TVL ratio', naiveFn),
  ];
}

/** Paired comparison of |error| differences: t, Cohen's d and a 95% CI. */
function pairedStats(diffs: number[]): { t: number; d: number; ci: [number, number] } {
  const n = diffs.length;
  const mean = diffs.reduce((s, v) => s + v, 0) / n;
  const sd = Math.sqrt(diffs.reduce((s, v) => s + (v - mean) ** 2, 0) / (n - 1));
  const se = sd / Math.sqrt(n);
  return {
    t: sd === 0 ? 0 : Math.round((mean / se) * 100) / 100,
    d: sd === 0 ? 0 : Math.round((mean / sd) * 100) / 100,
    ci: [Math.round((mean - 1.96 * se) * 10000) / 10000, Math.round((mean + 1.96 * se) * 10000) / 10000],
  };
}

/**
 * The model bake-off: forty-five specifications, each leave-one-out
 * backtested on the same live set, each compared to the shipped
 * specification by a paired t-test, Cohen's d, a 95% confidence interval
 * and a fold-win share, all over the same folds. The shipped row is fixed
 * by SHIP_SPEC, not picked at run time; the table exists so the choice can
 * be checked, not re-decided.
 */
export function runBakeOff(live: Proto[], asOfMs: number): CandidateResult[] {
  const specs = specTable(asOfMs);
  const shippedFn = specs.find((c) => c.shipped)!.fn;
  const shippedAbs = looResiduals(shippedFn, live).map(Math.abs);
  const results = specs.map((c) => {
    const errs = looResiduals(c.fn, live);
    const summary = errorSummary(errs);
    let pairedT: number | null = null;
    let cohensD: number | null = null;
    let ci95: [number, number] | null = null;
    let winShare: number | null = null;
    if (!c.shipped) {
      const diffs = errs.map((e, i) => Math.abs(e) - shippedAbs[i]!);
      const stats = pairedStats(diffs);
      pairedT = stats.t;
      cohensD = stats.d;
      ci95 = stats.ci;
      const wins = errs.filter((e, i) => Math.abs(e) < shippedAbs[i]!).length;
      winShare = Math.round((wins / errs.length) * 10000) / 10000;
    }
    return { name: c.name, shipped: c.shipped, paramFamily: c.paramFamily, summary, pairedT, cohensD, ci95, winShare };
  });
  return results.sort((a, b) => a.summary.mae - b.summary.mae || (a.name < b.name ? -1 : 1));
}

/**
 * The harder splits for the five closest specifications plus the shipped
 * one: a LOO leader that only wins by memorising its own category or size
 * band falls behind here, and the research note shows the numbers.
 */
export function hardSplits(live: Proto[], asOfMs: number, candidates: CandidateResult[]): SplitRow[] {
  const specs = new Map(specTable(asOfMs).map((c) => [c.name, c]));
  const picked = candidates
    .slice(0, 5)
    .concat(candidates.filter((c) => c.shipped))
    .filter((c, i, arr) => arr.findIndex((x) => x.name === c.name) === i);
  return picked.map((c) => {
    const fn = specs.get(c.name)!.fn;
    return {
      name: c.name,
      shipped: c.shipped,
      loo_mae: c.summary.mae,
      loco_mae: errorSummary(locoResiduals(fn, live)).mae,
      band_mae: errorSummary(bandResiduals(fn, live)).mae,
    };
  });
}

/** Leave-one-category-out: hold out each category whole, predict it cold. */
export function locoResiduals(fitFn: FitFn, live: Proto[]): number[] {
  const cats = [...new Set(live.map(categoryOf))].sort();
  const errs: number[] = [];
  for (const c of cats) {
    const test = live.filter((p) => categoryOf(p) === c);
    const train = live.filter((p) => categoryOf(p) !== c);
    if (train.length < 20) continue;
    const f = fitFn(train);
    for (const p of test) errs.push(Math.log10(p.mcap_usd!) - f(p));
  }
  return errs;
}

/** TVL-band holdout: hold out each third of the size range in turn. */
export function bandResiduals(fitFn: FitFn, live: Proto[]): number[] {
  const xs = live.map((p) => Math.log10(p.tvl_usd)).sort((a, b) => a - b);
  const t1 = xs[Math.floor(xs.length / 3)]!;
  const t2 = xs[Math.floor((2 * xs.length) / 3)]!;
  const band = (p: Proto): number => (Math.log10(p.tvl_usd) < t1 ? 0 : Math.log10(p.tvl_usd) < t2 ? 1 : 2);
  const errs: number[] = [];
  for (let b = 0; b < 3; b++) {
    const test = live.filter((p) => band(p) === b);
    const train = live.filter((p) => band(p) !== b);
    const f = fitFn(train);
    for (const p of test) errs.push(Math.log10(p.mcap_usd!) - f(p));
  }
  return errs;
}

export interface CalibrationEntry {
  category: string;
  n: number;
  offset: number;
  meanLooResid: number;
  meanAbsLooResid: number;
}

/** Per-category calibration: how the curve treats each category out of sample. */
export function categoryCalibration(live: Proto[], fit: Fit, looErrs: number[]): CalibrationEntry[] {
  const groups = new Map<string, number[]>();
  live.forEach((p, i) => {
    const k = categoryOf(p);
    if (!groups.has(k)) groups.set(k, []);
    groups.get(k)!.push(looErrs[i]!);
  });
  return [...groups.entries()]
    .sort((a, b) => b[1].length - a[1].length || (a[0] < b[0] ? -1 : 1))
    .map(([category, es]) => ({
      category,
      n: es.length,
      offset: Math.round((fit.catOffsets.get(category) ?? 0) * 10000) / 10000,
      meanLooResid: Math.round((es.reduce((s, v) => s + v, 0) / es.length) * 1000) / 1000,
      meanAbsLooResid: Math.round((es.reduce((s, v) => s + Math.abs(v), 0) / es.length) * 1000) / 1000,
    }));
}

// ---------------------------------------------------------------- comparables

export interface Comparable {
  slug: string;
  name: string;
  tvl_usd: number;
  mcap_usd: number;
  ratio: number;
  same_category: boolean;
  fitted_value_usd: number;
  error_factor: number;
  /** True when the trim dropped this protocol before the final fit: its
      ratio was too extreme to let bend the curve, so its gap is expected. */
  trimmed: boolean;
}

/**
 * The five live protocols nearest in TVL size: same-category neighbours
 * first, then the nearest overall. Each carries the model's own fitted
 * value for it, so the reader can see how the curve prices real neighbours
 * instead of taking the fit on trust.
 */
export function nearestLive(
  fit: Fit,
  live: Proto[],
  target: Proto,
  asOfMs: number,
  params: Params,
  k = 5,
): Comparable[] {
  const lx = Math.log10(target.tvl_usd);
  const ranked = live
    .map((p) => ({ p, d: Math.abs(Math.log10(p.tvl_usd) - lx) }))
    .sort((a, b) => a.d - b.d || (a.p.slug < b.p.slug ? -1 : 1));
  const same = ranked.filter((r) => categoryOf(r.p) === categoryOf(target));
  const picked: { p: Proto; d: number }[] = [];
  const seen = new Set<string>();
  for (const r of same.slice(0, 3)) {
    picked.push(r);
    seen.add(r.p.slug);
  }
  for (const r of ranked) {
    if (picked.length >= k) break;
    if (seen.has(r.p.slug)) continue;
    picked.push(r);
    seen.add(r.p.slug);
  }
  picked.sort((a, b) => a.d - b.d || (a.p.slug < b.p.slug ? -1 : 1));
  const trimmedSet = new Set(fit.trimmedSlugs);
  return picked.map(({ p }) => {
    const fitted = valueUsd(fit, p, asOfMs, params);
    return {
      slug: p.slug,
      name: p.name,
      tvl_usd: p.tvl_usd,
      mcap_usd: p.mcap_usd!,
      ratio: Math.round((p.mcap_usd! / p.tvl_usd) * 10000) / 10000,
      same_category: categoryOf(p) === categoryOf(target),
      fitted_value_usd: fitted,
      error_factor: Math.round((p.mcap_usd! / Math.max(1, fitted)) * 100) / 100,
      trimmed: trimmedSet.has(p.slug),
    };
  });
}

// ---------------------------------------------------------------- board selection

const EXCLUDED_CATEGORIES = new Set(['Bridge', 'Canonical Bridge', 'Liquid Staking', 'Liquid Restaking', 'Restaked BTC', 'CEX']);
const EXCHANGE_NAME = /^(Binance|Coinbase|Bybit|Kraken|Bitget|OKX|Bitfinex|Gemini)\b/i;
const VERSION_SUFFIX = /\s(v\d+(\.\d+)*|\d+\.\d+(\.\d+)*)$/i;
const WRAPPED_TERM = /\b(wrapped|staked|staking)\b/i;

/**
 * The house rule's wrapped / staked / bridged tests, from RULES.txt: the
 * category is a bridge, staking or exchange product, the name carries a
 * whole word wrapped/staked/staking, or begins with an exchange's name.
 * The watchlist applies all four tests plus the version-marker test. The
 * early set applies the first three in full — a wrapped product is never
 * ranked as a launch — but a version marker alone does not exclude a
 * protocol: a V2 deployment is the protocol's current version, not a
 * wrapped product of a token that trades. Versioned families are
 * deduplicated instead (see familyName): only the largest version of a
 * family is ranked.
 */
export function isWrappedProduct(p: Proto): boolean {
  if (EXCLUDED_CATEGORIES.has(p.category ?? '')) return true;
  if (WRAPPED_TERM.test(p.name)) return true;
  if (EXCHANGE_NAME.test(p.name)) return true;
  return false;
}

/** True when the name ends in a version marker (a space, then V2, 2.0…). */
export function hasVersionSuffix(p: Proto): boolean {
  return VERSION_SUFFIX.test(p.name);
}

/** The name with a trailing version marker stripped: the protocol family. */
export function familyName(p: Proto): string {
  return p.name.replace(VERSION_SUFFIX, '');
}

/** A protocol records no token when the snapshot carries no cap, id or symbol. */
export function hasNoToken(p: Proto): boolean {
  return p.mcap_usd === null && p.gecko_id === null && p.symbol === null;
}

/**
 * A partial token record: the snapshot carries a CoinGecko id or a symbol
 * but no market cap. The token trades — the record just carries no price —
 * so these protocols are neither ranked nor used to calibrate the curve.
 */
export function hasPartialToken(p: Proto): boolean {
  return p.mcap_usd === null && (p.gecko_id !== null || p.symbol !== null);
}

/** A live protocol: a positive market cap and a positive TVL. */
export function isTrading(p: Proto): boolean {
  return p.mcap_usd !== null && p.mcap_usd > 0 && p.tvl_usd > 0;
}

// ---------------------------------------------------------------- rows and dashboard data

export interface BoardRow {
  rank: number;
  slug: string;
  name: string;
  category: string | null;
  chains: string[];
  tvl_usd: number;
  change_7d: number | null;
  mcap_usd: null;
  listed_at: string | null;
  gecko_id: null;
  symbol: null;
  token_status: 'pre-token';
  watchlist: boolean;
  age_days: number | null;
  implied_value_usd: number;
  interval_50: [number, number];
  interval_80: [number, number];
  breakdown: Breakdown;
  live_in_category: number;
  comparables: Comparable[];
  farm_steps: string[];
}

export interface LiveRow {
  slug: string;
  name: string;
  category: string | null;
  chains: string[];
  tvl_usd: number;
  change_7d: number | null;
  mcap_usd: number;
  fitted_value_usd: number;
  error_factor: number;
}

export interface CompositionAudit {
  /** Pre-token protocols in the snapshot (no cap, id or symbol). */
  pre_token_total: number;
  /** Pre-token protocols excluded by each house-rule test (a protocol can hit several). */
  excluded_category: number;
  excluded_wrapped_word: number;
  excluded_exchange_prefix: number;
  /** Version-tailed protocols admitted to the early set under the family rule. */
  version_tail_admitted: number;
  /** Version-tailed protocols dropped as the smaller version of a family. */
  version_tail_deduped: string[];
  /** Protocols recording a token id or symbol but no market cap: neither ranked nor calibrating. */
  partial_token_records: number;
  /** Live protocols with a market cap at or below zero: not calibrating. */
  nonpositive_mcap: number;
}

export interface SelectionOutcome {
  /** The parameter set the board was priced with. */
  params: Params;
  /** The candidate that won the selection rule, or the v4 specification when the rule kept it. */
  winner_name: string;
  /** Whether the rule moved away from the v4 specification. */
  switched: boolean;
  /** The rule's reasoning, in one sentence, for the research note. */
  note: string;
}

export interface DashData {
  meta: {
    as_of: string;
    floor_usd: number;
    snapshot_protocols: number;
    live_protocols: number;
    pre_token_protocols: number;
    watchlist_size: number;
    board_size: number;
    early_size: number;
  };
  model: {
    intercept: number;
    slope: number;
    r_squared: number;
    resid_sd: number;
    kept_count: number;
    trimmed_count: number;
    live_count: number;
    shrink_prior: number;
    trim_sd: number;
    trim_rounds: number;
    growth_weight: number;
    growth_clamp: [number, number];
    age_amp: number;
    age_cap_days: number;
    unknown_age_days: number;
    trimmed_slugs: string[];
    offsets: { category: string; offset: number; offset_factor: number; live_count: number }[];
  };
  selection: SelectionOutcome;
  backtest: ErrorStats & {
    bands: ErrorBands;
    histogram: { bin: number; count: number }[];
    loco: ErrorStats;
    band_holdout: ErrorStats;
    coverage50: number;
    coverage80: number;
  };
  candidates: CandidateResult[];
  harder_splits: SplitRow[];
  calibration: CalibrationEntry[];
  composition: CompositionAudit;
  rows: BoardRow[];
  live: LiveRow[];
  scatter: { slug: string; name: string; category: string; x: number; y: number; trimmed: boolean }[];
  fit_line: { x1: number; y1: number; x2: number; y2: number };
}

/** The interval endpoints for one row, from the backtest's residual quantiles. */
export function intervalsFor(
  value: number,
  bands: ErrorBands,
): { interval50: [number, number]; interval80: [number, number] } {
  const lo50 = bound(Math.round(value * Math.pow(10, bands.q25)), 1, 100_000_000_000_000);
  const hi50 = bound(Math.round(value * Math.pow(10, bands.q75)), 1, 100_000_000_000_000);
  const lo80 = bound(Math.round(value * Math.pow(10, bands.q10)), 1, 100_000_000_000_000);
  const hi80 = bound(Math.round(value * Math.pow(10, bands.q90)), 1, 100_000_000_000_000);
  return { interval50: [lo50, hi50], interval80: [lo80, hi80] };
}

// ---------------------------------------------------------------- farm plans

/** Capital suggestion by TVL tier: thin pools get test sizes, deep pools more. */
function capitalForTier(tvl: number): { capital: string; half: string; note: string } {
  if (tvl < 10_000_000) return { capital: '$25–$50', half: '$15–$25', note: 'a test size, because the pool is thin and exits can slip' };
  if (tvl < 100_000_000) return { capital: '$100–$250', half: '$50–$125', note: 'a modest size for a mid-sized pool' };
  if (tvl < 1_000_000_000) return { capital: '$250–$500', half: '$125–$250', note: 'a working size for a deep pool' };
  return { capital: '$500–$1,000', half: '$250–$500', note: 'a working size; the pool is deep enough to enter and leave cleanly' };
}

const WALLET_BY_CHAIN: Record<string, string> = {
  Solana: 'a Solana wallet',
  Sui: 'a Sui wallet',
  Aptos: 'an Aptos wallet',
  Tron: 'a Tron wallet',
  'TON': 'a TON wallet',
  Cardano: 'a Cardano wallet',
  Near: 'a NEAR wallet',
  Starknet: 'a Starknet wallet',
  Cosmos: 'a Cosmos wallet',
  Osmosis: 'a Cosmos wallet',
  Injective: 'an Injective wallet',
  Sei: 'a Sei wallet',
  Celestia: 'a Cosmos wallet',
  Kava: 'a Cosmos wallet',
  Terra: 'a Terra wallet',
  'dYdX': 'a dYdX wallet',
  Canton: 'a Canton wallet',
  Proton: 'a Proton wallet',
  PlatON: 'a PlatON wallet',
  Noble: 'a Cosmos wallet',
  Bitcoincash: 'a Bitcoin Cash wallet',
};

function walletForChain(chain: string): string {
  return WALLET_BY_CHAIN[chain] ?? 'an EVM wallet';
}

// Gas wording follows the protocol's first chain, because a dollar of gas
// means different things in different places: Ethereum mainnet is the only
// chain where a DeFi interaction routinely costs dollars, most other chains
// charge under a dollar, and the fast non-EVM chains charge cents. The
// branch templates carry generic gas phrases; applyGasTier rewrites them
// to the chain's tier after filling, so every step's cost stays concrete.
const LOW_FEE_CHAINS = new Set([
  'Solana', 'Sui', 'Aptos', 'Tron', 'TON', 'Cardano', 'Near', 'Cosmos', 'Osmosis',
  'Injective', 'Sei', 'Celestia', 'Kava', 'Terra', 'dYdX', 'Canton', 'Proton',
  'PlatON', 'Noble', 'Bitcoincash', 'Stellar', 'Ripple', 'Algorand', 'Zcash',
  'Doge', 'Litecoin', 'XION', 'Aleo',
]);

function gasWords(chain: string): { standard: string; exit: string } {
  if (chain === 'Ethereum') return { standard: 'about $3–12 of gas', exit: 'about $3–10' };
  if (LOW_FEE_CHAINS.has(chain)) return { standard: 'a few cents of fees', exit: 'a few cents' };
  return { standard: 'under $1 of gas', exit: 'under $1' };
}

/** Rewrite a step's generic gas phrases to the first chain's tier. Bridge
    and payment fees are the protocol's own charges, not gas, and are left
    exactly as the branch wrote them. */
function applyGasTier(step: string, chain: string): string {
  const { standard, exit } = gasWords(chain);
  return step
    .replace(/about \$[0-9–-]+ of gas/g, standard)
    .replace(/exit gas, about \$[0-9–-]+/g, `exit gas, ${exit}`);
}

/** A deterministic pick from variants, so plans differ without randomness. */
function pickVariant<T>(variants: T[], slug: string, salt: number): T {
  let h = 2166136261;
  const s = `${slug}:${salt}`;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return variants[Math.abs(h) % variants.length]!;
}

function fillTemplate(template: string, vars: Record<string, string>): string {
  let out = template;
  for (const [k, v] of Object.entries(vars)) out = out.split(`{${k}}`).join(v);
  return out;
}

interface Branch {
  asset: string;
  open: string;
  weekly: string;
  risk: string;
}

// One branch per mechanism: what to actually DO differs by what the
// protocol IS, so each category gets its own open position, weekly rhythm
// and risk review. Placeholders: {N} name, {C} first chain, {C2} second
// chain, {K} capital, {H} half capital, {A} typical asset, {X} the
// cross-chain clause, which is dropped whole when there is no second chain.
const BRANCHES: Record<string, Branch> = {
  'Risk Curators': {
    asset: 'USDC',
    open: 'Put {K} of {A} into two or three curator vaults run through {N} on {C}, spreading the deposit so no single curator holds it all, {X}and open a smaller {H} vault on a second chain. Cost: {K} of capital and about $1–3 of gas. Time: 15 minutes.',
    weekly: 'Each week, look at what every curator did with the allocation, read any rebalancing notices, and move {H} toward the curator whose vaults earned most after fees. Keep a note of every vault address you hold. Cost: about $1–2 of gas per rebalance. Time: 10 minutes a week.',
    risk: 'The curator is the risk here: one can misallocate or be exploited, and vault shares can fall below the assets put in. If a curator\u2019s vault drops over 5% in a week, or its allocation changes with no notice, pull that leg out and wait. Cost: nothing to check. Time: 5 minutes.',
  },
  'Dexs': {
    asset: 'USDC',
    open: 'Add {K} of liquidity to one {N} pool on {C} — a stable pair for a quiet ride, a volatile pair only if you accept the swings — {X}and open a smaller {H} position on a second chain the protocol runs on. Cost: {K} of capital and about $1–4 of gas. Time: 15 minutes.',
    weekly: 'Each week, claim or compound the trading fees the pool earned, look at whether its volume is holding up, and shift {H} to the busiest pool if yours has gone quiet. Cost: about $1–3 of gas per claim. Time: 10 minutes a week.',
    risk: 'Impermanent loss is the risk: if the pair\u2019s price ratio moves far, withdrawing can return less than simply holding the assets. Watch the pool\u2019s ratio weekly; if it moved over 20% against you, check whether the fees earned still cover it before adding more. Cost: nothing to check. Time: 5 minutes.',
  },
  'Onchain Capital Allocator': {
    asset: 'USDC',
    open: 'Send {K} of {A} into {N}\u2019s allocation vaults on {C}, split across two strategies rather than one, {X}and mirror {H} on a second chain so the wallet shows multi-chain allocation. Cost: {K} of capital and about $1–3 of gas. Time: 15 minutes.',
    weekly: 'Each week, see where the allocator moved funds, compare each strategy\u2019s yield after fees, and shift {H} toward the best risk-adjusted one. Note any strategy that stops reporting. Cost: about $1–2 of gas per shift. Time: 10 minutes a week.',
    risk: 'Allocator risk compounds: funds sit in strategies the allocator picks, so a bad strategy or a paused vault can trap capital. If a strategy stops updating its reports or withdrawals queue for days, exit that leg. Cost: nothing to check. Time: 5 minutes.',
  },
  'Lending': {
    asset: 'USDC',
    open: 'Lend {K} of {A} on {N} on {C}, and if you borrow, keep it under half the collateral value with a stable asset borrowed against a stable deposit, {X}then repeat a {H} supply leg on a second chain. Cost: {K} of capital and about $1–3 of gas. Time: 15 minutes.',
    weekly: 'Each week, check borrow rates and your health factor, repay or add collateral if the factor falls under 2, and claim any supply incentives. Cost: about $1–3 of gas per adjustment. Time: 10 minutes a week.',
    risk: 'Liquidation is the risk: a falling collateral price can liquidate a borrow and take a penalty. Never borrow against a volatile asset at high leverage, and set a price alert 20% above your liquidation price so you can act before it hits. Cost: nothing to check. Time: 5 minutes.',
  },
  'Yield': {
    asset: 'USDC',
    open: 'Put {K} of {A} into {N}\u2019s largest yield vault on {C}, choosing the vault whose strategy you understand over the one with the highest advertised rate, {X}and add {H} to a second vault on another chain. Cost: {K} of capital and about $1–3 of gas. Time: 15 minutes.',
    weekly: 'Each week, compare the vault\u2019s realised yield with its advertised rate, harvest or compound rewards, and move {H} if the realised rate has run below half the advertised one for two weeks. Cost: about $1–3 of gas per harvest. Time: 10 minutes a week.',
    risk: 'Yield risk hides in the strategy: leveraged or looping strategies can unwind fast in a falling market. If the vault\u2019s TVL drops over 25% in a week, pause deposits and check whether the strategy, not just the market, is the cause. Cost: nothing to check. Time: 5 minutes.',
  },
  'Derivatives': {
    asset: 'USDC',
    open: 'Open a small {K} margin position on {N} on {C} at low leverage (2x or less) with a stop-loss set before entry, using {A} as collateral, {X}and keep a {H} spot leg on a second chain so the wallet is not only leveraged exposure. Cost: {K} of margin and about $1–4 of gas. Time: 20 minutes.',
    weekly: 'Each week, review open positions, funding rates and liquidation distances, close anything held past its plan, and never add to a losing position to average down. Cost: about $1–3 of gas per close. Time: 15 minutes a week.',
    risk: 'Leverage is the risk: a fast move can liquidate the whole margin before you react, and funding rates can bleed a position held for weeks. If funding turns sharply against you for three days running, close and wait rather than paying to hold. Cost: nothing to check. Time: 5 minutes.',
  },
  'RWA': {
    asset: 'USDC',
    open: 'Buy {K} of {N}\u2019s tokenised real-world asset on {C} after confirming which off-chain asset backs it and who custodies it, {X}and hold a {H} second position in a different asset class the protocol offers. Cost: {K} of capital and about $1–3 of gas. Time: 20 minutes.',
    weekly: 'Each week, check the issuer\u2019s attestations or reports for the backing assets, confirm redemption windows are open, and claim any yield distributions. Cost: about $1–2 of gas per claim. Time: 10 minutes a week.',
    risk: 'Custody and redemption risk: the token is only as good as the off-chain asset and the issuer\u2019s redemption process. If attestations lapse, redemption queues grow, or the token trades far below its stated backing, exit while the window is open. Cost: nothing to check. Time: 5 minutes.',
  },
  'Yield Aggregator': {
    asset: 'USDC',
    open: 'Deposit {K} of {A} into {N}\u2019s auto-compounding vault on {C}, picking the strategy with the longest track record over the newest high-yield one, {X}and add {H} to a second strategy on another chain. Cost: {K} of capital and about $1–3 of gas. Time: 15 minutes.',
    weekly: 'Each week, check the vault\u2019s harvest history and net APY after fees, and rotate {H} if the vault has missed harvests or its APY has halved without explanation. Cost: about $1–3 of gas per rotation. Time: 10 minutes a week.',
    risk: 'Aggregator risk stacks: the vault\u2019s strategy sits on other protocols, so an exploit downstream reaches you too. If any underlying protocol pauses or is exploited, withdraw from vaults that route through it the same day. Cost: nothing to check. Time: 5 minutes.',
  },
  'CDP': {
    asset: 'ETH',
    open: 'Open a collateralised debt position on {N} on {C} with {K} of {A} as collateral, minting stablecoins at no more than half the maximum loan-to-value, {X}and open a smaller {H} position on a second chain. Cost: {K} of collateral and about $1–4 of gas. Time: 20 minutes.',
    weekly: 'Each week, check your collateral ratio and the stability fee, top up collateral or repay debt if the ratio falls toward the liquidation line, and claim any position rewards. Cost: about $1–3 of gas per adjustment. Time: 10 minutes a week.',
    risk: 'Liquidation is the risk: a sharp collateral drop can trigger a forced sale at a penalty. Keep the ratio above twice the minimum, and never mint to the maximum — the extra headroom is what survives a weekend crash. Cost: nothing to check. Time: 5 minutes.',
  },
  'Basis Trading': {
    asset: 'USDC',
    open: 'Deposit {K} of {A} into {N}\u2019s basis vault on {C}, which earns the spread between spot and futures, starting with the vault whose strategy disclosure you can actually follow, {X}and add {H} to a second basis market on another chain. Cost: {K} of capital and about $1–3 of gas. Time: 15 minutes.',
    weekly: 'Each week, check the funding-rate environment the strategy depends on, compare realised returns to the vault\u2019s stated range, and pause deposits if funding has been negative for a full week. Cost: about $1–2 of gas per adjustment. Time: 10 minutes a week.',
    risk: 'Basis risk: the trade earns only while futures trade above spot, and a funding flip can turn the yield negative while the vault keeps charging fees. If the vault\u2019s weekly return goes negative twice in a row, withdraw and reassess. Cost: nothing to check. Time: 5 minutes.',
  },
  'Liquidity Manager': {
    asset: 'USDC',
    open: 'Deposit {K} of {A} into {N}\u2019s managed liquidity position on {C}, letting the manager set the price range, and read how often it rebalances before committing, {X}then add {H} to a second managed range on another chain. Cost: {K} of capital and about $1–3 of gas. Time: 15 minutes.',
    weekly: 'Each week, check whether your range is still in the active price band, review rebalance frequency and fees paid, and move {H} if the position has sat out of range for a week earning nothing. Cost: about $1–3 of gas per move. Time: 10 minutes a week.',
    risk: 'Range risk: a concentrated position out of range earns no fees while still carrying price exposure, and frequent rebalancing eats returns in gas. If the manager rebalances daily in a choppy market, the gas bill can exceed the fees — check the net, not the gross. Cost: nothing to check. Time: 5 minutes.',
  },
  'Leveraged Farming': {
    asset: 'USDC',
    open: 'Open a leveraged farm on {N} on {C} with {K} at the lowest leverage the protocol offers, on a pair you would hold unleveraged, with a written exit price before entry, {X}and keep a {H} unleveraged leg on a second chain. Cost: {K} of capital and about $2–5 of gas. Time: 20 minutes.',
    weekly: 'Each week, check the position\u2019s health, borrow cost and farm rewards, deleverage if the borrow rate has doubled, and never increase leverage on a losing position. Cost: about $2–4 of gas per adjustment. Time: 15 minutes a week.',
    risk: 'Leverage plus farming risk: borrow costs can exceed farm rewards, and a price move can liquidate the leveraged leg. If the net yield after borrow cost turns negative for a week, close the leverage and keep only the unleveraged leg. Cost: nothing to check. Time: 5 minutes.',
  },
  'Chain': {
    asset: 'the chain\u2019s native asset',
    open: 'Bridge {K} of {A} to {N} on {C} using the chain\u2019s official bridge, then use a native app — a swap or a stake — so the wallet shows real activity, not just a bridged balance, {X}and repeat a {H} leg from a second source chain. Cost: {K} of capital and about $2–6 of bridge and gas fees. Time: 20 minutes.',
    weekly: 'Each week, use one more native app on the chain, check the chain\u2019s status page for outages or upgrades, and keep a small gas reserve so a fee spike never strands the wallet. Cost: about $1–3 of gas a week. Time: 15 minutes a week.',
    risk: 'Chain risk: a young chain can halt, fork or change fees, and bridged assets can be stuck during an outage. Never bridge funds you need this week, and keep the bulk of holdings on the chain you trust most. Cost: nothing to check. Time: 5 minutes.',
  },
  'Staking Pool': {
    asset: 'the stakeable asset',
    open: 'Stake {K} of {A} in {N}\u2019s pool on {C}, choosing a pool with a clear unbonding period you can live with, {X}and split {H} across a second validator or pool so one operator\u2019s failure does not take everything. Cost: {K} of capital and about $1–3 of gas. Time: 15 minutes.',
    weekly: 'Each week, check validator uptime and commission changes, restake or claim rewards, and move stake away from any validator whose uptime falls below 98%. Cost: about $1–2 of gas per restake. Time: 10 minutes a week.',
    risk: 'Slashing and lock risk: a misbehaving validator can cost a slice of stake, and unbonding periods lock funds for days or weeks. Read the unbonding terms before staking, and never stake funds you may need before the lock ends. Cost: nothing to check. Time: 5 minutes.',
  },
  'Anchor BTC': {
    asset: 'BTC',
    open: 'Deposit {K} of {A} with {N} on {C} to mint or hold its anchored BTC representation, after confirming the custody or federation model and the redemption path, {X}and keep a {H} leg on a second chain if the protocol supports it. Cost: {K} of capital and about $2–6 of fees. Time: 20 minutes.',
    weekly: 'Each week, check the peg of the anchored asset against BTC, confirm redemptions are processing, and claim any yield the deposit earns. Cost: about $1–3 of gas per claim. Time: 10 minutes a week.',
    risk: 'Peg and custody risk: an anchored asset can depeg if redemption stalls or custody is questioned. If the peg slips more than 1% for more than a day, or redemption queues appear, redeem while the path is open. Cost: nothing to check. Time: 5 minutes.',
  },
  'Decentralized BTC': {
    asset: 'BTC',
    open: 'Lock {K} of {A} in {N}\u2019s decentralised BTC vault on {C}, verifying the federation or threshold-signing setup and the exit procedure first, {X}and hold {H} in a second BTC venue so one bridge design is not your only exposure. Cost: {K} of capital and about $2–6 of fees. Time: 20 minutes.',
    weekly: 'Each week, verify the vault\u2019s BTC backing disclosures, check the peg, and confirm the exit path is still live with a small test if the protocol allows it. Cost: about $1–3 of gas per check. Time: 10 minutes a week.',
    risk: 'Bridge and federation risk: decentralised BTC depends on signers behaving, and a signer failure can freeze exits. If backing disclosures stop or the peg slips, start the exit procedure immediately — queues form fast. Cost: nothing to check. Time: 5 minutes.',
  },
  'Dual-Token Stablecoin': {
    asset: 'USDC',
    open: 'Mint or buy {K} of {N}\u2019s stable asset on {C} with {A}, keeping the paired yield or governance token exposure small until you understand how the two tokens interact, {X}and add {H} on a second chain. Cost: {K} of capital and about $1–3 of gas. Time: 15 minutes.',
    weekly: 'Each week, check both tokens\u2019 pegs and the collateral ratio backing the stable asset, claim yield, and rebalance if the paired token has moved sharply against the stable one. Cost: about $1–3 of gas per rebalance. Time: 10 minutes a week.',
    risk: 'Dual-token risk: the stable asset\u2019s peg can depend on the paired token holding value, so a crash in one can break the other. If the stable asset trades below $0.99 for a day, exit to plain stablecoins and reassess. Cost: nothing to check. Time: 5 minutes.',
  },
  'Farm': {
    asset: 'USDC',
    open: 'Stake {K} of {A} or LP tokens in {N}\u2019s farm on {C}, choosing the pool with the longest-running rewards over the newest boosted one, {X}and add {H} to a second pool on another chain. Cost: {K} of capital and about $1–3 of gas. Time: 15 minutes.',
    weekly: 'Each week, harvest rewards, check whether the reward token\u2019s price is falling faster than you earn it, and move {H} if the net return after the reward token\u2019s slide is negative. Cost: about $1–3 of gas per harvest. Time: 10 minutes a week.',
    risk: 'Reward-token risk: farm rewards paid in a token that inflates can lose value faster than you harvest. Sell or compound rewards promptly rather than letting them sit, and exit pools whose reward token has halved in a month. Cost: nothing to check. Time: 5 minutes.',
  },
};

const BRANCHES_2: Record<string, Branch> = {
  'Prediction Market': {
    asset: 'USDC',
    open: 'Place {K} across two or three {N} markets on {C} where you have a genuine view, sizing each stake small enough to lose, {X}and add a {H} position in a longer-dated market on a second chain. Cost: {K} of capital and about $1–3 of gas. Time: 15 minutes.',
    weekly: 'Each week, review open positions against new information, close markets whose thesis has changed, and never chase losses by doubling a stake. Cost: about $1–2 of gas per close. Time: 10 minutes a week.',
    risk: 'Resolution risk: markets can resolve ambiguously or late, and low-liquidity markets can move prices against you on entry and exit. Avoid markets with thin order books, and read the resolution criteria before staking, not after. Cost: nothing to check. Time: 5 minutes.',
  },
  'Uncollateralized Lending': {
    asset: 'USDC',
    open: 'Lend {K} of {A} through {N} on {C} only after reading who the borrowers are, what underwriting exists, and what happens on a default, {X}and split {H} across a second borrower pool. Cost: {K} of capital and about $1–3 of gas. Time: 20 minutes.',
    weekly: 'Each week, check borrower repayment status and any late-payment notices, and pause new lending if a borrower misses a payment. Cost: about $1–2 of gas per adjustment. Time: 10 minutes a week.',
    risk: 'Default risk is uncollateralised: a borrower who does not repay leaves no collateral to seize. Treat every pool as money that can go to zero, and never concentrate in one borrower or one pool. Cost: nothing to check. Time: 5 minutes.',
  },
  'Interest Rate Derivatives': {
    asset: 'USDC',
    open: 'Trade {K} of {A} on {N} on {C} by splitting yield tokens from principal on a position you already understand, starting with the shortest maturity, {X}and keep {H} in the un-split underlying on a second chain. Cost: {K} of capital and about $1–4 of gas. Time: 20 minutes.',
    weekly: 'Each week, check implied yields against realised yields, roll positions before maturity, and close any yield-token leg whose implied rate has collapsed. Cost: about $1–3 of gas per roll. Time: 15 minutes a week.',
    risk: 'Rate risk: yield tokens decay to zero at maturity, and a fixed-rate leg locks you out of rising yields. Never hold a yield token past maturity expecting value, and size fixed legs so a rate move cannot strand the position. Cost: nothing to check. Time: 5 minutes.',
  },
  'Cross Chain Bridge': {
    asset: 'USDC',
    open: 'Bridge {K} of {A} through {N} from {C} to a second chain the protocol supports, using a small test transfer first to confirm the route and timing, {X}then run a {H} transfer on a second route. Cost: {K} of capital and about $2–6 of bridge fees. Time: 20 minutes.',
    weekly: 'Each week, bridge a small amount on a different route, check transfer times and fees against alternatives, and keep a gas reserve on each destination chain. Cost: about $2–5 of fees per transfer. Time: 10 minutes a week.',
    risk: 'Bridge risk: transfers can stall for hours or days, and a bridge exploit can freeze in-flight funds. Never bridge funds you need the same day, and test every new route with a small amount before the real transfer. Cost: nothing to check. Time: 5 minutes.',
  },
  'CDP Manager': {
    asset: 'ETH',
    open: 'Open a managed CDP through {N} on {C} with {K} of {A}, letting the manager automate the collateral ratio, and read its automation triggers before depositing, {X}then open a {H} position on a second chain. Cost: {K} of collateral and about $1–4 of gas. Time: 20 minutes.',
    weekly: 'Each week, check the automation log — what it rebalanced and why — verify the collateral ratio yourself, and adjust the automation bounds if the market has turned volatile. Cost: about $1–3 of gas per adjustment. Time: 10 minutes a week.',
    risk: 'Automation risk: a manager that rebalances in a flash crash can sell collateral at the worst price. Set wide automation bounds, keep manual override ready, and never automate a position you would not manage by hand. Cost: nothing to check. Time: 5 minutes.',
  },
  'OTC Marketplace': {
    asset: 'USDC',
    open: 'Complete one small {K} trade on {N} on {C} through its escrowed OTC flow, verifying the counterparty\u2019s history and the escrow terms before sending anything, {X}and repeat a {H} trade with a different counterparty. Cost: {K} of capital and about $1–3 of gas. Time: 20 minutes.',
    weekly: 'Each week, check open offers and your trade history, leave honest feedback after each completed trade, and never move a deal off-escrow to save fees. Cost: about $1–2 of gas per trade. Time: 10 minutes a week.',
    risk: 'Counterparty risk: off-escrow deals and rushed counterparties are how OTC funds disappear. Use the escrow every time, verify addresses in the escrow contract itself, and walk away from any deal that pressures you to skip a step. Cost: nothing to check. Time: 5 minutes.',
  },
  'CeDeFi': {
    asset: 'USDC',
    open: 'Deposit {K} of {A} with {N} on {C} after confirming which centralised venue holds the funds and what on-chain proof of reserves exists, {X}and hold {H} in a fully on-chain venue as a comparison leg. Cost: {K} of capital and about $1–3 of gas. Time: 20 minutes.',
    weekly: 'Each week, check proof-of-reserves updates and withdrawal processing times, and test a small withdrawal monthly so you know the exit works before you need it. Cost: about $1–3 of gas per test. Time: 10 minutes a week.',
    risk: 'Custody risk: a centralised venue can pause withdrawals, and on-chain proof is only as good as its last update. If withdrawals slow or proofs lapse, withdraw while the path is open — do not wait for an announcement. Cost: nothing to check. Time: 5 minutes.',
  },
  'Crypto Card Issuer': {
    asset: 'USDC',
    open: 'Order or activate {N}\u2019s card with {K} of {A} loaded on {C}, confirming fees, limits and supported regions before funding it, {X}and keep {H} in the linked wallet rather than on the card itself. Cost: {K} of capital plus any card fee the issuer states. Time: 20 minutes.',
    weekly: 'Each week, use the card for one real purchase, check the statement for unexpected fees, and top up only what you plan to spend. Cost: the card\u2019s stated transaction fees. Time: 5 minutes a week.',
    risk: 'Issuer risk: a card program can freeze, change fees or lose its banking partner. Keep card balances small, keep records of every load, and never treat a card balance as savings. Cost: nothing to check. Time: 5 minutes.',
  },
  'Indexes': {
    asset: 'USDC',
    open: 'Buy {K} of {N}\u2019s index token on {C}, reading the index composition and rebalance rules first so you know what you actually hold, {X}and add {H} to a second index with different constituents. Cost: {K} of capital and about $1–3 of gas. Time: 15 minutes.',
    weekly: 'Each week, check the index\u2019s composition drift and the next rebalance date, and compare its performance against holding the constituents directly. Cost: about $1–2 of gas per adjustment. Time: 10 minutes a week.',
    risk: 'Composition risk: an index can drift into assets you would not hold, and rebalances can sell low and buy high in volatile markets. If the composition changes toward assets you do not want, exit rather than holding by inertia. Cost: nothing to check. Time: 5 minutes.',
  },
  'Stablecoin Wrapper': {
    asset: 'USDC',
    open: 'Wrap {K} of {A} into {N}\u2019s wrapped stablecoin on {C}, confirming the backing, the wrapper\u2019s fee and the unwrap path before converting, {X}and hold {H} in the unwrapped stablecoin as a control leg. Cost: {K} of capital and about $1–3 of gas. Time: 15 minutes.',
    weekly: 'Each week, check the wrapped token\u2019s peg and the backing disclosures, and test a small unwrap monthly so the exit stays familiar. Cost: about $1–2 of gas per test. Time: 10 minutes a week.',
    risk: 'Wrapper risk: a wrapped stablecoin can depeg if backing is questioned or unwraps queue. If the peg slips more than 0.5% or unwrap times grow, unwrap to the base stablecoin promptly. Cost: nothing to check. Time: 5 minutes.',
  },
  'Restaking': {
    asset: 'ETH',
    open: 'Restake {K} of {A} through {N} on {C}, choosing operators with public track records and reading the slashing conditions for each service you secure, {X}and split {H} across a second operator. Cost: {K} of capital and about $1–4 of gas. Time: 20 minutes.',
    weekly: 'Each week, check operator performance and any new slashing conditions added to the services you secure, and move stake away from operators with downtime. Cost: about $1–3 of gas per move. Time: 10 minutes a week.',
    risk: 'Slashing risk stacks across services: securing many services multiplies the ways stake can be cut. Secure only services you understand, and keep total restaked exposure below what you can afford to lose to a slashing event. Cost: nothing to check. Time: 5 minutes.',
  },
  'Insurance': {
    asset: 'USDC',
    open: 'Buy {K} of cover on {N} on {C} for a protocol you already use, reading the covered events and exclusions before paying the premium, {X}and compare a {H} quote for a second protocol. Cost: {K} of premium and about $1–3 of gas. Time: 20 minutes.',
    weekly: 'Each week, check your cover\u2019s expiry and whether the covered protocol has changed in ways that affect the policy, and renew before expiry rather than after. Cost: the renewal premium when due. Time: 5 minutes a week.',
    risk: 'Claims risk: cover pays only for events the policy names, and claims can be disputed. Read the exclusions twice, keep records of the position you insured, and never assume a hack automatically means a payout. Cost: nothing to check. Time: 5 minutes.',
  },
  'Payments': {
    asset: 'USDC',
    open: 'Send one real {K} payment through {N} on {C} to a recipient you trust, confirming fees, settlement time and reversibility first, {X}and repeat a {H} payment on a second chain the protocol supports. Cost: {K} of capital and about $1–3 of fees. Time: 15 minutes.',
    weekly: 'Each week, use the payment flow once more, check settlement times against the protocol\u2019s claims, and keep a log of every payment\u2019s reference. Cost: about $1–2 of fees per payment. Time: 5 minutes a week.',
    risk: 'Payment risk: crypto payments are usually irreversible, so a wrong address or a stalled settlement loses funds outright. Test every new recipient with a tiny amount first, and verify addresses character by character. Cost: nothing to check. Time: 5 minutes.',
  },
  'Privacy': {
    asset: 'ETH',
    open: 'Use {N} on {C} with {K} of {A} for one private transfer or shielded interaction, reading the anonymity-set size and withdrawal delays first, {X}and keep a {H} transparent leg so the wallet\u2019s history stays explainable. Cost: {K} of capital and about $1–4 of gas. Time: 20 minutes.',
    weekly: 'Each week, check the anonymity set\u2019s size and any compliance notices, and withdraw on the protocol\u2019s recommended schedule rather than rushing. Cost: about $1–3 of gas per withdrawal. Time: 10 minutes a week.',
    risk: 'Privacy-tool risk: small anonymity sets weaken privacy, and some venues refuse funds that touched privacy tools. Understand the trade-offs before depositing, and keep records of lawful use. Cost: nothing to check. Time: 5 minutes.',
  },
  'Options Vault': {
    asset: 'USDC',
    open: 'Deposit {K} of {A} into {N}\u2019s options vault on {C}, choosing the strategy whose payoff diagram you can explain — covered calls before anything exotic, {X}and add {H} to a second vault with a different strategy. Cost: {K} of capital and about $1–4 of gas. Time: 20 minutes.',
    weekly: 'Each week, check the vault\u2019s epoch results, implied volatility against realised, and whether the strategy is earning its premium or giving it back. Cost: about $1–3 of gas per adjustment. Time: 10 minutes a week.',
    risk: 'Options risk: selling volatility earns small steady premiums and can lose large in a sharp move. If the vault loses two epochs in a row, pause deposits and check whether the strategy, not luck, is the cause. Cost: nothing to check. Time: 5 minutes.',
  },
  'Governance Incentives': {
    asset: 'USDC',
    open: 'Lock or delegate {K} of {A} through {N} on {C} to earn governance incentives, reading the lock duration and vote-escrow mechanics before committing, {X}and split {H} across a second gauge or pool. Cost: {K} of capital and about $1–3 of gas. Time: 15 minutes.',
    weekly: 'Each week, vote or reallocate gauges, claim incentives, and check whether the incentive rate has fallen below the lock\u2019s opportunity cost. Cost: about $1–2 of gas per vote. Time: 10 minutes a week.',
    risk: 'Lock risk: vote-escrowed positions cannot be sold during the lock, so a falling market locks in the loss. Never lock funds you may need, and favour shorter locks until the incentive rate proves stable. Cost: nothing to check. Time: 5 minutes.',
  },
  'Collateral Markets': {
    asset: 'USDC',
    open: 'Supply {K} of {A} as collateral on {N} on {C}, checking which assets the market accepts and the liquidation terms for each, {X}and add a {H} supply leg in a second collateral type. Cost: {K} of capital and about $1–3 of gas. Time: 15 minutes.',
    weekly: 'Each week, check collateral factor changes and the health of any borrow against your supply, and withdraw collateral the market no longer accepts promptly. Cost: about $1–3 of gas per adjustment. Time: 10 minutes a week.',
    risk: 'Collateral risk: a market can delist a collateral type or cut its factor, forcing a sudden repayment or liquidation. Keep borrows small relative to supply, and watch governance proposals that touch collateral terms. Cost: nothing to check. Time: 5 minutes.',
  },
};

const FALLBACK_BRANCH: Branch = {
  asset: 'USDC',
  open: 'Use {N} on {C} with {K} of {A} in its main product — the one holding most of its TVL — after reading what the product does and what it charges, {X}and add {H} on a second chain the protocol runs on. Cost: {K} of capital and about $1–3 of gas. Time: 15 minutes.',
  weekly: 'Each week, check the position\u2019s returns, the protocol\u2019s TVL trend and any announcements, and claim or compound whatever it distributes. Cost: about $1–3 of gas per claim. Time: 10 minutes a week.',
  risk: 'General risk: unaudited or new code, changing fees and falling TVL are the early warnings. If TVL falls 25% in a week, announcements stop, or withdrawals slow, exit the position and reassess from outside. Cost: nothing to check. Time: 5 minutes.',
};

function branchForCategory(category: string | null): Branch {
  if (category === null) return FALLBACK_BRANCH;
  return BRANCHES[category] ?? BRANCHES_2[category] ?? FALLBACK_BRANCH;
}

/** Step 1: the wallet, fitted to the chains the protocol actually runs on. */
function walletPlanStep(p: Proto, slug: string): string {
  const primary = walletForChain(p.chains[0] ?? 'Ethereum');
  const families = new Set(p.chains.map(walletForChain));
  const multi = families.size > 1 ? ` ${p.name} spans ${families.size} wallet families, so set up each type before bridging anything between them.` : '';
  const variants = [
    `Set up a dedicated farm wallet — ${primary} — separate from savings, write the recovery phrase on paper and store it offline, then fund it with gas money for ${p.chains[0] ?? 'its chain'}.${multi} Cost: the gas for one small funding transfer. Time: 10 minutes.`,
    `Create a fresh wallet for this farm only, ${primary}, back up its recovery phrase offline before it receives anything, and load enough gas for several transactions on ${p.chains[0] ?? 'its chain'}.${multi} Cost: one funding transfer. Time: 10 minutes.`,
  ];
  return pickVariant(variants, slug, 1);
}

/** Step 2: verify before depositing, with the protocol's age as context. */
function verifyPlanStep(p: Proto, asOfMs: number, slug: string): string {
  const age = daysListed(p, asOfMs);
  const ageNote =
    age === null
      ? 'Its listing date is unreported, so treat its track record as unverified.'
      : age < 180
        ? `It has run only ${age} days, so its track record is short — start small.`
        : age > 730
          ? `It has run ${age} days with no token, so do not assume a launch is near; farm the product, not the rumour.`
          : `It has run ${age} days, a real track record, but still verify the current state.`;
  const growthNote = p.change_7d !== null && p.change_7d < -20 ? ` TVL fell ${Math.abs(p.change_7d).toFixed(1)}% in the last week — find out why before depositing.` : '';
  const variants = [
    `Before depositing, read ${p.name}\u2019s own docs and audit reports, confirm the official app address from two independent sources, and check whether any points program exists and what it actually rewards. ${ageNote}${growthNote} Cost: nothing but time. Time: 20 minutes.`,
    `Verify first: open ${p.name}\u2019s documentation, check its audits and any incident history, confirm the app link from the protocol\u2019s own channels, and read the terms of any points program before assuming it pays. ${ageNote}${growthNote} Cost: nothing but time. Time: 20 minutes.`,
  ];
  return pickVariant(variants, slug, 2);
}

/** Step 6: track the position, so nothing drifts unnoticed. */
function trackPlanStep(p: Proto, slug: string): string {
  const variants = [
    `Set up tracking for this position: a monthly calendar reminder, a price and TVL alert for ${p.name}, and one line in a log for every deposit, claim and withdrawal with its transaction hash. Cost: nothing but time. Time: 10 minutes to set up, 5 minutes a month.`,
    `Track it from day one: note the deposit amounts, dates and transaction hashes in one place, set a monthly reminder to review the position, and add a TVL alert so a sharp fall reaches you instead of being discovered weeks later. Cost: nothing but time. Time: 10 minutes to set up, 5 minutes a month.`,
  ];
  return pickVariant(variants, slug, 6);
}

/** Step 7: the hold, fitted to how long the protocol has already run. */
function holdPlanStep(slug: string, age: number | null): string {
  const horizon = age === null || age < 365 ? 'Plan to hold the position at least 8–12 weeks' : 'Plan to hold at least one full season or quarter';
  const variants = [
    `${horizon}, checking monthly whether any points program has started, changed its rules or ended, and keep a dated log of every deposit, claim and withdrawal with transaction hashes. Cost: nothing but time. Time: 15 minutes a month.`,
    `${horizon} and review monthly: has a points program appeared, have its rules changed, is the protocol\u2019s TVL still growing? Keep a dated log of deposits, claims and withdrawals. Cost: nothing but time. Time: 15 minutes a month.`,
  ];
  return pickVariant(variants, slug, 7);
}

/** Step 8: the exit, planned before it is needed. */
function exitPlanStep(slug: string): string {
  const variants = [
    `Decide the exit in advance: unwind in stages when the position reaches your target, a points program ends, or the risk review fails — never all at once in a panic — then reconcile the log and move proceeds back to the main wallet. Cost: exit gas, about $1–4. Time: 15 minutes.`,
    `Plan the exit now: leave in stages if the position hits your target, the program ends or the risks change, keep the transaction log for records, and never leave dust in a farm wallet you stop watching. Cost: exit gas, about $1–4. Time: 15 minutes.`,
  ];
  return pickVariant(variants, slug, 8);
}

/** Keep a step inside the gate's 600 characters, cutting at a sentence end. */
function trimStep(s: string): string {
  const t = s.replace(/\s+/g, ' ').trim();
  if (t.length <= 600) return t;
  const cut = t.lastIndexOf('. ', 597);
  if (cut > 100) return t.slice(0, cut + 1);
  return `${t.slice(0, 597).trimEnd()}…`;
}

/** Eight steps: wallet, verify, open, weekly rhythm, risk review, track, hold, exit. */
export function buildFarmPlan(p: Proto, asOfMs: number): string[] {
  const branch = branchForCategory(p.category);
  const tier = capitalForTier(p.tvl_usd);
  const chain1 = p.chains[0] ?? 'its chain';
  const chain2 = p.chains[1];
  const vars: Record<string, string> = {
    N: p.name,
    C: chain1,
    C2: chain2 ?? chain1,
    K: tier.capital,
    H: tier.half,
    A: branch.asset,
    X: '',
  };
  // The open step's cross-chain clause only makes sense when a second chain
  // exists; without one, drop the whole clause instead of naming no chain.
  const openTpl = chain2 ? branch.open : branch.open.replace(/\s*(,|—)\s*\{X\}[^.]*\./, '.');
  let open = fillTemplate(openTpl, vars);
  if (chain2) {
    open = open
      .replace('second chain', `second chain (${chain2})`)
      .replace('another chain', `another chain (${chain2})`)
      .replace('second route', `second route (${chain2})`);
  }
  const steps = [
    walletPlanStep(p, p.slug),
    verifyPlanStep(p, asOfMs, p.slug),
    open,
    fillTemplate(branch.weekly, vars),
    fillTemplate(branch.risk, vars),
    trackPlanStep(p, p.slug),
    holdPlanStep(p.slug, daysListed(p, asOfMs)),
    exitPlanStep(p.slug),
  ];
  // A fast-growing protocol gets a sizing caution in its open step, placed
  // before the cost sentence: momentum is when oversizing hurts most.
  if (p.change_7d !== null && p.change_7d >= 30 && steps[2]!.includes(' Cost: ')) {
    steps[2] = steps[2]!.replace(
      ' Cost: ',
      ` TVL jumped ${p.change_7d.toFixed(1)}% in a week — start at the small end of the size range and add only after a week of watching it hold. Cost: `,
    );
  }
  return steps.map((s) => trimStep(applyGasTier(s, chain1)));
}

// ---------------------------------------------------------------- build

export interface Built {
  board: BoardRow[];
  dash: DashData;
}

/**
 * The selection rule, stated once: among the power-law parameter variants,
 * the lowest leave-one-out MAE ships only when it beats the v4
 * specification with a paired t below -2. Anything else keeps the v4
 * specification, and the dashboard says so. Structural alternatives are
 * never eligible: the page recomputes every row from an intercept, a slope,
 * offsets, a growth factor and a seasoning factor, and a shipped form the
 * reader cannot re-derive would break that check.
 */
const PARAM_VARIANTS: Record<string, Params> = {
  'Power law + offsets, prior 4': { shrinkPrior: 4, trimSd: 2, trimRounds: 1, growthWeight: 0.15, ageAmp: 0.1 },
  'Power law + offsets, prior 6': { shrinkPrior: 6, trimSd: 2, trimRounds: 1, growthWeight: 0.15, ageAmp: 0.1 },
  'Power law + offsets, prior 8': { shrinkPrior: 8, trimSd: 2, trimRounds: 1, growthWeight: 0.15, ageAmp: 0.1 },
  'Power law + offsets, prior 16': { shrinkPrior: 16, trimSd: 2, trimRounds: 1, growthWeight: 0.15, ageAmp: 0.1 },
  'Power law + offsets, prior 20': { shrinkPrior: 20, trimSd: 2, trimRounds: 1, growthWeight: 0.15, ageAmp: 0.1 },
  'Power law + offsets, prior 24': { shrinkPrior: 24, trimSd: 2, trimRounds: 1, growthWeight: 0.15, ageAmp: 0.1 },
  'Power law + offsets, prior 32': { shrinkPrior: 32, trimSd: 2, trimRounds: 1, growthWeight: 0.15, ageAmp: 0.1 },
  'Power law, trim 1.5 SD': { shrinkPrior: 12, trimSd: 1.5, trimRounds: 1, growthWeight: 0.15, ageAmp: 0.1 },
  'Power law, trim 2.5 SD': { shrinkPrior: 12, trimSd: 2.5, trimRounds: 1, growthWeight: 0.15, ageAmp: 0.1 },
  'Power law, trim 3 SD': { shrinkPrior: 12, trimSd: 3, trimRounds: 1, growthWeight: 0.15, ageAmp: 0.1 },
  'Power law, trim 2 rounds': { shrinkPrior: 12, trimSd: 2, trimRounds: 2, growthWeight: 0.15, ageAmp: 0.1 },
  'Power law, no trim': { shrinkPrior: 12, trimSd: 1e9, trimRounds: 0, growthWeight: 0.15, ageAmp: 0.1 },
  'Power law, growth weight 0.10': { shrinkPrior: 12, trimSd: 2, trimRounds: 1, growthWeight: 0.1, ageAmp: 0.1 },
  'Power law, growth weight 0.20': { shrinkPrior: 12, trimSd: 2, trimRounds: 1, growthWeight: 0.2, ageAmp: 0.1 },
  'Power law, no growth factor': { shrinkPrior: 12, trimSd: 2, trimRounds: 1, growthWeight: 0, ageAmp: 0.1 },
  'Power law, seasoning amp 0.05': { shrinkPrior: 12, trimSd: 2, trimRounds: 1, growthWeight: 0.15, ageAmp: 0.05 },
  'Power law, seasoning amp 0.15': { shrinkPrior: 12, trimSd: 2, trimRounds: 1, growthWeight: 0.15, ageAmp: 0.15 },
  'Power law, no seasoning factor': { shrinkPrior: 12, trimSd: 2, trimRounds: 1, growthWeight: 0.15, ageAmp: 0 },
  'Power law, no growth or seasoning': { shrinkPrior: 12, trimSd: 2, trimRounds: 1, growthWeight: 0, ageAmp: 0 },
};

const BASE_PARAMS: Params = {
  shrinkPrior: SHIP_SPEC.shrinkPrior,
  trimSd: SHIP_SPEC.trimSd,
  trimRounds: SHIP_SPEC.trimRounds,
  growthWeight: SHIP_SPEC.growthWeight,
  ageAmp: SHIP_SPEC.ageAmp,
};

/** Apply the selection rule to the bake-off table: pick the shipped knobs. */
function chooseShipped(candidates: CandidateResult[]): { params: Params; selection: SelectionOutcome } {
  const shippedRow = candidates.find((c) => c.shipped)!;
  const eligible = candidates
    .filter((c) => !c.shipped && PARAM_VARIANTS[c.name] !== undefined)
    .sort((a, b) => a.summary.mae - b.summary.mae || (a.name < b.name ? -1 : 1));
  const best = eligible[0];
  if (best !== undefined && best.pairedT !== null && best.pairedT < -2) {
    const chosen = PARAM_VARIANTS[best.name]!;
    return {
      params: chosen,
      selection: {
        params: chosen,
        winner_name: best.name,
        switched: true,
        note: `The selection rule switched the shipped specification to ${best.name}: leave-one-out MAE ${best.summary.mae.toFixed(3)} against the v4 specification's ${shippedRow.summary.mae.toFixed(3)}, paired t ${best.pairedT.toFixed(2)} — a significant win, so it ships.`,
      },
    };
  }
  if (best !== undefined) {
    const gap = shippedRow.summary.mae - best.summary.mae;
    return {
      params: BASE_PARAMS,
      selection: {
        params: BASE_PARAMS,
        winner_name: 'Power law + shrunk offsets (prior 12) — shipped',
        switched: false,
        note: `The selection rule kept the v4 specification: the best parameter variant, ${best.name}, leads by ${gap.toFixed(3)} dex with paired t ${best.pairedT === null ? '—' : best.pairedT.toFixed(2)} — noise, not signal — so nothing moved.`,
      },
    };
  }
  return {
    params: BASE_PARAMS,
    selection: {
      params: BASE_PARAMS,
      winner_name: 'Power law + shrunk offsets (prior 12) — shipped',
      switched: false,
      note: 'The selection rule kept the v4 specification: no parameter variant was eligible to challenge it.',
    },
  };
}

/**
 * Fit, backtest, bake off, and rank. The board is every watchlist protocol
 * plus every remaining pre-token protocol that is not a wrapped, staked or
 * bridged product under the category, wrapped-word and exchange-prefix
 * tests, with versioned families deduplicated to their largest version.
 */
export function buildEntry(snap: Snap): Built {
  const asOfMs = Date.parse(`${snap.as_of}T00:00:00Z`);
  const live = snap.protocols.filter(isTrading).sort((a, b) => (a.slug < b.slug ? -1 : 1));
  const candidates = runBakeOff(live, asOfMs);
  const { params: chosen, selection } = chooseShipped(candidates);

  const fit = fitCurve(live, chosen.shrinkPrior, chosen.trimSd, chosen.trimRounds);
  const shipped = (train: Proto[]): Predictor =>
    powerLawFn(train, asOfMs, chosen.shrinkPrior, chosen.trimSd, chosen.trimRounds, chosen.growthWeight, chosen.ageAmp);

  const looErrs = looResiduals(shipped, live);
  const summary = errorSummary(looErrs);
  const bands = errorBands(looErrs);
  const coverage = bandCoverage(looErrs, bands);
  const histogram = errorHistogram(looErrs);
  const loco = errorSummary(locoResiduals(shipped, live));
  const bandHoldout = errorSummary(bandResiduals(shipped, live));
  const splits = hardSplits(live, asOfMs, candidates);
  const calibration = categoryCalibration(live, fit, looErrs);

  const watchSet = new Set(snap.watchlist);
  // Early candidates: pre-token, passing the three wrapped-product tests.
  // Version-tailed names stay in; families are deduplicated below.
  const early = snap.protocols
    .filter((p) => hasNoToken(p) && !watchSet.has(p.slug) && !isWrappedProduct(p))
    .sort((a, b) => (a.slug < b.slug ? -1 : 1));
  // Family dedupe: when several versions of one base name qualify, keep
  // only the largest TVL, so no family is ranked twice. Watchlist rows are
  // never deduped (none carries a version tail under the house rule).
  const bestByFamily = new Map<string, Proto>();
  const deduped: string[] = [];
  for (const p of early) {
    const base = familyName(p);
    const cur = bestByFamily.get(base);
    if (cur === undefined) bestByFamily.set(base, p);
    else if (p.tvl_usd > cur.tvl_usd) {
      deduped.push(cur.slug);
      bestByFamily.set(base, p);
    } else deduped.push(p.slug);
  }
  const boardProtocols = snap.protocols
    .filter((p) => watchSet.has(p.slug) || bestByFamily.get(familyName(p)) === p)
    .sort((a, b) => (a.slug < b.slug ? -1 : 1));
  const scored = boardProtocols.map((p) => {
    const { logValue, breakdown } = predictRow(fit, p, asOfMs, chosen);
    const value = bound(Math.round(Math.pow(10, logValue)), 1, 100_000_000_000_000);
    return { p, value, breakdown };
  });
  scored.sort((a, b) => b.value - a.value || (a.p.slug < b.p.slug ? -1 : 1));
  const board: BoardRow[] = scored.map(({ p, value, breakdown }, i) => {
    const { interval50, interval80 } = intervalsFor(value, bands);
    return {
      rank: i + 1,
      slug: p.slug,
      name: p.name,
      category: p.category,
      chains: [...p.chains],
      tvl_usd: p.tvl_usd,
      change_7d: p.change_7d,
      mcap_usd: null,
      listed_at: p.listed_at,
      gecko_id: null,
      symbol: null,
      token_status: 'pre-token',
      watchlist: watchSet.has(p.slug),
      age_days: daysListed(p, asOfMs),
      implied_value_usd: value,
      interval_50: interval50,
      interval_80: interval80,
      breakdown,
      live_in_category: fit.liveByCat.get(categoryOf(p)) ?? 0,
      comparables: nearestLive(fit, live, p, asOfMs, chosen),
      farm_steps: buildFarmPlan(p, asOfMs),
    };
  });

  const liveRows: LiveRow[] = [...live]
    .sort((a, b) => b.tvl_usd - a.tvl_usd || (a.slug < b.slug ? -1 : 1))
    .slice(0, 24)
    .map((p) => {
      const fitted = valueUsd(fit, p, asOfMs, chosen);
      return {
        slug: p.slug,
        name: p.name,
        category: p.category,
        chains: [...p.chains],
        tvl_usd: p.tvl_usd,
        change_7d: p.change_7d,
        mcap_usd: p.mcap_usd!,
        fitted_value_usd: fitted,
        error_factor: Math.round((p.mcap_usd! / Math.max(1, fitted)) * 100) / 100,
      };
    });

  const xs = live.map((p) => Math.log10(p.tvl_usd));
  const xMin = Math.min(...xs);
  const xMax = Math.max(...xs);
  const scatter = live.map((p) => ({
    slug: p.slug,
    name: p.name,
    category: categoryOf(p),
    x: Math.round(Math.log10(p.tvl_usd) * 1000) / 1000,
    y: Math.round(Math.log10(p.mcap_usd!) * 1000) / 1000,
    trimmed: fit.trimmedSlugs.includes(p.slug),
  }));

  // Full precision: the page recomputes every row from these numbers, so
  // rounding them here would make the recompute disagree by a few dollars.
  const offsets = [...fit.catOffsets.entries()]
    .sort((a, b) => (a[0] < b[0] ? -1 : 1))
    .map(([category, offset]) => ({
      category,
      offset,
      offset_factor: Math.pow(10, offset),
      live_count: fit.liveByCat.get(category) ?? 0,
    }));

  // The composition audit: what the board left out, and why, counted from
  // the snapshot itself so the research note reports facts, not claims.
  const preToken = snap.protocols.filter(hasNoToken);
  const nonWatchPre = preToken.filter((p) => !watchSet.has(p.slug));
  const composition: CompositionAudit = {
    pre_token_total: preToken.length,
    excluded_category: nonWatchPre.filter((p) => EXCLUDED_CATEGORIES.has(p.category ?? '')).length,
    excluded_wrapped_word: nonWatchPre.filter((p) => WRAPPED_TERM.test(p.name)).length,
    excluded_exchange_prefix: nonWatchPre.filter((p) => EXCHANGE_NAME.test(p.name)).length,
    version_tail_admitted: board.filter((r) => VERSION_SUFFIX.test(r.name)).length,
    version_tail_deduped: deduped.sort(),
    partial_token_records: snap.protocols.filter(hasPartialToken).length,
    nonpositive_mcap: snap.protocols.filter((p) => p.mcap_usd !== null && p.mcap_usd <= 0).length,
  };

  const dash: DashData = {
    meta: {
      as_of: snap.as_of,
      floor_usd: snap.floor_usd,
      snapshot_protocols: snap.protocols.length,
      live_protocols: live.length,
      pre_token_protocols: snap.protocols.filter(hasNoToken).length,
      watchlist_size: snap.watchlist.length,
      board_size: board.length,
      early_size: board.length - snap.watchlist.length,
    },
    model: {
      intercept: fit.intercept,
      slope: fit.slope,
      r_squared: Math.round(fit.r2 * 10000) / 10000,
      resid_sd: Math.round(fit.residSD * 1000) / 1000,
      kept_count: fit.kept,
      trimmed_count: fit.trimmed,
      live_count: fit.liveN,
      shrink_prior: chosen.shrinkPrior,
      trim_sd: chosen.trimSd,
      trim_rounds: chosen.trimRounds,
      growth_weight: chosen.growthWeight,
      growth_clamp: [SHIP_SPEC.growthLo, SHIP_SPEC.growthHi],
      age_amp: chosen.ageAmp,
      age_cap_days: SHIP_SPEC.ageCapDays,
      unknown_age_days: SHIP_SPEC.unknownAgeDays,
      trimmed_slugs: fit.trimmedSlugs,
      offsets,
    },
    selection,
    backtest: {
      ...summary,
      bands,
      histogram,
      loco,
      band_holdout: bandHoldout,
      coverage50: Math.round(coverage.cover50 * 1000) / 1000,
      coverage80: Math.round(coverage.cover80 * 1000) / 1000,
    },
    candidates,
    harder_splits: splits,
    calibration,
    composition,
    rows: board,
    live: liveRows,
    scatter,
    fit_line: { x1: xMin, y1: fit.intercept + fit.slope * xMin, x2: xMax, y2: fit.intercept + fit.slope * xMax },
  };
  return { board, dash };
}

/** The dashboard's data as a script: one global, deterministic key order. */
export function dashboardScript(dash: DashData): string {
  return `window.RADAR = ${JSON.stringify(dash)};\n`;
}

/**
 * The board problems the gate would refuse, in the gate's own terms, or
 * null when the board is clean. main.ts fails loudly instead of handing
 * in a board the gate refuses.
 */
export function boardIssues(board: BoardRow[], snap: Snap): string | null {
  if (board.length < 100 || board.length > 4000) return `board holds ${board.length} rows, outside 100 to 4000`;
  const slugs = new Set(snap.protocols.map((p) => p.slug));
  const seen = new Set<string>();
  const ranks = new Set<number>();
  let prev = Number.POSITIVE_INFINITY;
  let allEqual = true;
  let first: number | null = null;
  for (const row of board) {
    if (!slugs.has(row.slug)) return `row names ${row.slug}, not one of the snapshot's protocols`;
    if (seen.has(row.slug)) return `row ${row.slug} appears twice`;
    seen.add(row.slug);
    if (typeof row.name !== 'string' || row.name.length === 0) return `row ${row.slug} has no name`;
    if (!Number.isInteger(row.rank) || row.rank < 1) return `row ${row.slug} has rank ${row.rank}`;
    ranks.add(row.rank);
    if (!Number.isInteger(row.implied_value_usd) || row.implied_value_usd < 1 || row.implied_value_usd > 100_000_000_000_000) {
      return `row ${row.slug} has implied value ${row.implied_value_usd}`;
    }
    if (first === null) first = row.implied_value_usd;
    else if (row.implied_value_usd !== first) allEqual = false;
    if (row.implied_value_usd > prev) return `row ${row.slug} rises above the row before it`;
    prev = row.implied_value_usd;
    if (!Array.isArray(row.farm_steps) || row.farm_steps.length < 3 || row.farm_steps.length > 12) {
      return `row ${row.slug} has ${row.farm_steps?.length} farm steps`;
    }
    for (const step of row.farm_steps) {
      const t = step.trim();
      if (t.length < 20 || t.length > 600) return `row ${row.slug} has a farm step of ${t.length} characters`;
    }
    if (row.interval_80[0] > row.implied_value_usd || row.interval_80[1] < row.implied_value_usd) {
      return `row ${row.slug} has an 80% interval that misses its own value`;
    }
    if (row.interval_50[0] > row.implied_value_usd || row.interval_50[1] < row.implied_value_usd) {
      return `row ${row.slug} has a 50% interval that misses its own value`;
    }
  }
  for (let r = 1; r <= board.length; r++) if (!ranks.has(r)) return `rank ${r} is missing`;
  if (allEqual && board.length >= 2) return 'all implied values are equal: the board ranks nothing';
  for (const w of snap.watchlist) if (!seen.has(w)) return `watchlist slug ${w} is missing from the board`;
  return null;
}
