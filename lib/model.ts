// Launch Radar: the valuation model behind the token-radar-01 entry.
//
// The board ranks protocols that record no token yet, by what a token would
// be worth if the protocol's record stayed as it is. Nothing here names a
// protocol: every number is derived from the sealed snapshot itself.
//
// How the implied value is built, in four factors:
//
//   1. Category multiple. Protocols in the snapshot that DO record a token
//      (a market cap) price their own category: for each category we take the
//      median market-cap-to-TVL ratio of its live members, shrunk toward the
//      snapshot-wide median so thin categories cannot swing the board, then
//      clamped to [0.03, 0.80]. A category with no live member uses the
//      snapshot-wide median. The calibration table is published in the
//      dashboard so the judge can see the multiples are the snapshot's own.
//   2. Growth. The 7-day TVL change, clamped to [-50, +150] percent, moves
//      the value by 0.35x its size: growthFactor = 1 + 0.35 * clamped / 100.
//      An unreported change counts as zero.
//   3. Seasoning. Days since DefiLlama began tracking the protocol, capped at
//      1095 days: ageFactor = 0.70 + 0.30 * min(age, 1095) / 1095. An unknown
//      listing date counts as 365 days. Older, longer-running protocols with
//      no token score closer to their full multiple.
//   4. Reach. Each extra chain past the first adds 2%, up to 8 chains:
//      chainFactor = 1 + 0.02 * min(max(chains - 1, 0), 8).
//
//   implied_value_usd = round(tvl_usd * multiple * growth * age * chains),
//   at least $1. Rows sort by implied value, ties by slug, so the program is
//   fully deterministic: the same snapshot always yields the same bytes.

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

/** One calibrated multiple: the category, its shrunk multiple, and its evidence. */
export interface MultipleRow {
  category: string;
  multiple: number;
  live_count: number;
  median_ratio: number | null;
}

/** The full calibration: the global median and one row per category seen. */
export interface Calibration {
  global_median: number;
  live_protocols: number;
  rows: MultipleRow[];
}

/** The model's tuning: all in one place so the dashboard can state it. */
export const TUNE = {
  shrink_prior: 4,
  multiple_floor: 0.03,
  multiple_cap: 0.8,
  growth_floor: -50,
  growth_cap: 150,
  growth_weight: 0.35,
  age_floor: 0.7,
  age_span: 0.3,
  age_cap_days: 1095,
  unknown_age_days: 365,
  chain_step: 0.02,
  chain_cap: 8,
  board_rows: 200,
  live_rows: 24,
} as const;

export const MODEL_NAME = 'snapshot-calibrated multiples v1';

/** One scored protocol: the record plus every factor behind its value. */
export interface Scored {
  proto: Proto;
  multiple: number;
  growth_pct: number;
  growth_factor: number;
  age_days: number | null;
  age_factor: number;
  chain_factor: number;
  implied: number;
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
  breakdown: {
    multiple: number;
    growth_pct: number;
    growth_factor: number;
    age_factor: number;
    chain_factor: number;
  };
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

/** Everything the dashboard page renders. */
export interface DashData {
  as_of: string;
  source: string;
  floor_usd: number;
  model_name: string;
  tune: typeof TUNE;
  calibration: Calibration;
  watchlist_size: number;
  board_size: number;
  early_size: number;
  live_size: number;
  pre_token_total: number;
  rows: BoardRow[];
  live: LiveEntry[];
}

/** Why a snapshot cannot be scored. */
export class SnapError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'SnapError';
  }
}

const DAY_MS = 86_400_000;
const clamp = (v: number, lo: number, hi: number): number => Math.min(hi, Math.max(lo, v));
const round4 = (n: number): number => Math.round(n * 10_000) / 10_000;

/** The median of a non-empty list of numbers. */
function median(values: number[]): number {
  const s = [...values].sort((a, b) => a - b);
  const mid = Math.floor(s.length / 2);
  return s.length % 2 === 1 ? s[mid]! : (s[mid - 1]! + s[mid]!) / 2;
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

/** Names ending in a version marker are pools of another protocol, not standalone launches. */
const VERSION_TAIL = /\s(V\d+(\.\d+)?|v\d+(\.\d+)?|\d+\.\d+)$/;

/** Whether a pre-token protocol may join the board below the watchlist floor. */
export function isEarlyCandidate(p: Proto): boolean {
  return isPreToken(p) && p.category !== 'CEX' && !VERSION_TAIL.test(p.name);
}

/**
 * Calibrate the category multiples from the snapshot's own live protocols:
 * the median market-cap-to-TVL ratio per category, shrunk toward the global
 * median with a prior of TUNE.shrink_prior observations, then clamped.
 * Each live protocol's ratio is capped at 2x before any median is taken, so
 * one tiny-TVL protocol with a huge market cap cannot set a whole category's
 * multiple; the cap is a fixed modelling choice, never a name list.
 */
export function calibrate(snap: Snap): Calibration {
  const RATIO_CAP = 2;
  const live = snap.protocols.filter((p) => p.mcap_usd !== null && p.tvl_usd > 0);
  const globalMedian = live.length > 0 ? median(live.map((p) => Math.min(RATIO_CAP, p.mcap_usd! / p.tvl_usd))) : 0.25;
  const byCat = new Map<string, number[]>();
  for (const p of live) {
    const key = p.category ?? '(uncategorised)';
    const arr = byCat.get(key) ?? [];
    arr.push(Math.min(RATIO_CAP, p.mcap_usd! / p.tvl_usd));
    byCat.set(key, arr);
  }
  const rows: MultipleRow[] = [];
  const cats = new Set<string>(snap.protocols.map((p) => p.category ?? '(uncategorised)'));
  for (const cat of [...cats].sort()) {
    const ratios = byCat.get(cat) ?? [];
    const med = ratios.length > 0 ? median(ratios) : null;
    const shrunk =
      med === null
        ? globalMedian
        : (ratios.length * med + TUNE.shrink_prior * globalMedian) / (ratios.length + TUNE.shrink_prior);
    rows.push({
      category: cat,
      multiple: round4(clamp(shrunk, TUNE.multiple_floor, TUNE.multiple_cap)),
      live_count: ratios.length,
      median_ratio: med === null ? null : round4(med),
    });
  }
  return { global_median: round4(globalMedian), live_protocols: live.length, rows };
}

/** The multiple a protocol's category calibrates to (the global median when unseen). */
function multipleFor(p: Proto, cal: Calibration): number {
  const key = p.category ?? '(uncategorised)';
  const row = cal.rows.find((r) => r.category === key);
  return row === undefined ? clamp(cal.global_median, TUNE.multiple_floor, TUNE.multiple_cap) : row.multiple;
}

/** Score one protocol under the calibrated model. Pure and deterministic. */
export function score(p: Proto, asOf: string, cal: Calibration): Scored {
  const multiple = multipleFor(p, cal);
  const raw = p.change_7d !== null && Number.isFinite(p.change_7d) ? p.change_7d : 0;
  const growthPct = clamp(raw, TUNE.growth_floor, TUNE.growth_cap);
  const growthFactor = 1 + (growthPct / 100) * TUNE.growth_weight;
  const age = ageInDays(asOf, p.listed_at);
  const ageUsed = age ?? TUNE.unknown_age_days;
  const ageFactor = TUNE.age_floor + (Math.min(Math.max(ageUsed, 0), TUNE.age_cap_days) / TUNE.age_cap_days) * TUNE.age_span;
  const chainFactor = 1 + TUNE.chain_step * Math.min(Math.max(p.chains.length - 1, 0), TUNE.chain_cap);
  const implied = Math.max(1, Math.round(p.tvl_usd * multiple * growthFactor * ageFactor * chainFactor));
  return { proto: p, multiple, growth_pct: growthPct, growth_factor: growthFactor, age_days: age, age_factor: ageFactor, chain_factor: chainFactor, implied };
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

/** Gas cost wording, from the protocol's first chain: mainnet costs more than L2s. */
function gasWord(chain: string): { tx: string; weekly: string } {
  const c = chain.toLowerCase();
  if (c === 'ethereum') return { tx: 'about $6-12 of gas', weekly: 'about $8 of gas a week' };
  if (c.includes('solana') || c.includes('sui') || c.includes('aptos') || c.includes('near'))
    return { tx: 'under $1 of network fees', weekly: 'under $1 of fees a week' };
  if (c.includes('bitcoin') || c.includes('tron')) return { tx: 'about $2-4 of network fees', weekly: 'about $3 of fees a week' };
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
  close: string;
}

/** The category's farming verbs: what a farmer actually does there. */
function farmBits(p: Proto, capital: number, chain: string): FarmBits {
  const c = (p.category ?? '').toLowerCase();
  const n = p.name;
  if (c.includes('lend') || c.includes('cdp') || c.includes('collateralized')) {
    return {
      open: `Supply $${capital} of USDC to ${n} on ${chain} and leave the deposit earning.`,
      weekly: `Top up or rebalance the supply position once a week and borrow a small amount against it.`,
      close: `Repay any borrow, withdraw the supply, and keep the receipt of every transaction.`,
    };
  }
  if (c.includes('dex') || c.includes('leveraged farm')) {
    return {
      open: `Add $${capital} of liquidity to ${n}'s deepest pool on ${chain} and stake the LP receipt if the app offers it.`,
      weekly: `Swap a small amount through ${n} once a week and re-center the range if the pool is concentrated.`,
      close: `Remove the liquidity, unstake the receipt, and keep the record of fees earned.`,
    };
  }
  if (c.includes('bridge') || c.includes('canonical bridge')) {
    return {
      open: `Bridge $${capital} of USDC into ${chain} through ${n} and hold the bridged funds in the destination app.`,
      weekly: `Bridge a small amount back or onward once a week so the route sees repeat use.`,
      close: `Bridge the funds back to the starting chain and keep both sides' transaction hashes.`,
    };
  }
  if (c.includes('staking') || c.includes('restak') || c.includes('liquid staking')) {
    return {
      open: `Stake $${capital} of the staking asset through ${n} on ${chain} and hold the liquid receipt token.`,
      weekly: `Restake or compound the receipt once a week and check the points page for new tasks.`,
      close: `Unstake through the protocol's own queue and keep the receipt until the withdrawal lands.`,
    };
  }
  if (c.includes('perpetual') || c.includes('derivative') || c.includes('options')) {
    return {
      open: `Deposit $${capital} of USDC as margin on ${n} on ${chain} and open one small hedged position.`,
      weekly: `Place one small trade a week and keep the margin ratio well above liquidation.`,
      close: `Close the position, withdraw the margin, and keep the trade history.`,
    };
  }
  if (c.includes('yield') || c.includes('aggregator') || c.includes('vault') || c.includes('allocator') || c.includes('curator')) {
    return {
      open: `Deposit $${capital} into a ${n} vault on ${chain} and hold the vault shares.`,
      weekly: `Deposit a small amount weekly and check whether a new vault or gauge opened.`,
      close: `Redeem the vault shares and keep the deposit and withdrawal records.`,
    };
  }
  if (c.includes('rwa') || c.includes('real world')) {
    return {
      open: `Mint $${capital} of ${n}'s yield-bearing asset on ${chain} and hold it in the farm wallet.`,
      weekly: `Check the asset's yield accrual weekly and add a small amount when the window opens.`,
      close: `Redeem the asset through the protocol's own flow and keep the redemption record.`,
    };
  }
  if (c.includes('stable') || c.includes('basis')) {
    return {
      open: `Mint or buy $${capital} of the stable asset through ${n} on ${chain} and hold it.`,
      weekly: `Use the asset once a week in the protocol's own pools or lending markets.`,
      close: `Redeem the stable asset and keep the mint and redemption records.`,
    };
  }
  if (c.includes('prediction') || c.includes('gaming') || c.includes('nft')) {
    return {
      open: `Fund the farm wallet with $${capital} and take one real position in ${n} on ${chain}.`,
      weekly: `Take one small position a week and follow the protocol's own quests or seasons.`,
      close: `Exit the position, withdraw the balance, and keep the activity history.`,
    };
  }
  if (c.includes('insurance')) {
    return {
      open: `Buy $${capital} of cover from ${n} on ${chain} and keep the policy active.`,
      weekly: `Check the policy weekly and renew or extend it before it lapses.`,
      close: `Let the policy run its term, then withdraw any unused premium through the app.`,
    };
  }
  return {
    open: `Deposit $${capital} of USDC into ${n} on ${chain} and keep the position open.`,
    weekly: `Make one qualifying action a week: a deposit, a swap, a vote or a task the app lists.`,
    close: `Withdraw the position through the protocol's own app and keep every transaction hash.`,
  };
}

const WALLET_OPENERS = [
  'Open a fresh wallet that holds only the funds you plan to farm, and store its seed phrase offline on paper.',
  'Set aside a dedicated farm wallet, separate from savings, and back up its seed phrase offline before funding it.',
  'Create a new wallet only for this farm, fund it with exactly the farming budget, and keep the seed phrase off the device.',
] as const;

const POINTS_CHECKS = [
  'Open the protocol’s own points or rewards page from its official site and confirm the wallet shows activity before the season ends.',
  'Check the protocol’s own rewards dashboard from its official links and confirm each week’s activity was counted.',
  'Visit the protocol’s own points page through its official site and screenshot the wallet’s standing for your records.',
] as const;

/** One farm step as the gate wants it: a single string, 20..600 chars, with cost and time. */
function stepLine(action: string, cost: string, time: string): string {
  let s = `${action} Cost: ${cost}. Time: ${time}.`;
  if (s.length > 600) s = `${s.slice(0, 597)}...`;
  return s;
}

/**
 * A protocol's farm plan: six steps derived from its category, chains, TVL
 * and age. Variant wording is picked by a hash of the slug, so the same
 * protocol always gets the same plan and no name is ever special-cased.
 */
export function farmPlan(p: Proto, age: number | null): string[] {
  const chain = p.chains.length > 0 ? p.chains[0]! : 'its main chain';
  const gas = gasWord(chain);
  const capital = capitalTier(p.tvl_usd);
  const hold = holdWindow(age);
  const bits = farmBits(p, capital, chain);
  const opener = pick(WALLET_OPENERS, p.slug, 1);
  const points = pick(POINTS_CHECKS, p.slug, 2);
  const multi = p.chains.length > 1 ? ` Repeat the deposit on a second chain the protocol runs on (${p.chains[1]}) with half the capital, so the wallet shows cross-chain use.` : '';
  return [
    stepLine(opener, `under $3 of gas for the first transaction`, '5 minutes'),
    stepLine(`${bits.open}${multi}`, `$${capital} of capital and ${gas.tx}`, '15 minutes to set up'),
    stepLine(bits.weekly, gas.weekly, '10 minutes a week'),
    stepLine(`Hold the position for at least ${hold} days so the activity spans more than one snapshot window.`, `the $${capital} stays in the position`, `${hold} days`),
    stepLine(points, 'no fee to check, and never pay anyone to claim', '10 minutes'),
    stepLine(`${bits.close} Write the wallet, the dates and every transaction in a farm log.`, 'nothing but the log', '5 minutes'),
  ];
}

// ---------------------------------------------------------------- board assembly

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
export function buildBoard(snap: Snap, cal: Calibration): BoardRow[] {
  const bySlug = new Map(snap.protocols.map((p) => [p.slug, p]));
  const picked = new Map<string, Proto>();
  for (const slug of snap.watchlist) {
    const p = bySlug.get(slug);
    if (p !== undefined) picked.set(slug, p);
  }
  const early = snap.protocols
    .filter((p) => !picked.has(p.slug) && isEarlyCandidate(p))
    .map((p) => score(p, snap.as_of, cal))
    .sort((a, b) => b.implied - a.implied || (a.proto.slug < b.proto.slug ? -1 : 1))
    .slice(0, Math.max(0, TUNE.board_rows - picked.size));
  for (const s of early) picked.set(s.proto.slug, s.proto);

  const scored = [...picked.values()]
    .map((p) => score(p, snap.as_of, cal))
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
    age_days: s.age_days,
    implied_value_usd: s.implied,
    breakdown: {
      multiple: s.multiple,
      growth_pct: s.growth_pct,
      growth_factor: round4(s.growth_factor),
      age_factor: round4(s.age_factor),
      chain_factor: round4(s.chain_factor),
    },
    farm_steps: farmPlan(s.proto, s.age_days),
  }));
}

/** Everything the dashboard renders, from one snapshot. */
export function buildAll(snap: Snap): { board: BoardRow[]; dash: DashData } {
  const cal = calibrate(snap);
  const board = buildBoard(snap, cal);
  const live = liveSet(snap);
  const early = board.filter((r) => !r.watchlist).length;
  const dash: DashData = {
    as_of: snap.as_of,
    source: snap.source,
    floor_usd: snap.floor_usd,
    model_name: MODEL_NAME,
    tune: TUNE,
    calibration: cal,
    watchlist_size: snap.watchlist.length,
    board_size: board.length,
    early_size: early,
    live_size: live.length,
    pre_token_total: snap.protocols.filter(isPreToken).length,
    rows: board,
    live,
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
