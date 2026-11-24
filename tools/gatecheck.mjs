// Gate self-check, v5: replicates the 7 gate checks from RULES.txt against
// an output directory, plus the entry's own invariants — dashboard source
// under 64 KB, 208 rows all pre-token, 5 comparables and 8 farm steps a row,
// the 45-specification bake-off with paired t-tests, Cohen's d, 95%
// confidence intervals and fold-win shares, the selection rule's outcome
// recorded, interval coverage reported, versioned families deduplicated,
// gas wording tiered by chain, and an exact recompute of every row's value
// and intervals from the published fit. Usage:
//   node tools/gatecheck.mjs <outdir> <snapshot.json>
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { buildDossier } from '../vendor/makefun-board.ts';

const [, , outDir, snapPath] = process.argv;
if (!outDir || !snapPath) {
  console.error('usage: node tools/gatecheck.mjs <outdir> <snapshot.json>');
  process.exit(2);
}

let failures = 0;
let passes = 0;
/** One verdict line; the run exits non-zero unless every check passes. */
function check(name, ok, detail) {
  console.log(`${ok ? 'PASS' : 'FAIL'} ${name}${detail ? ` — ${detail}` : ''}`);
  if (ok) passes++;
  else failures++;
}

const snap = JSON.parse(readFileSync(snapPath, 'utf8'));
const watch = new Set(snap.watchlist);
const bySlug = new Map(snap.protocols.map((p) => [p.slug, p]));
const PLAIN = /^[A-Za-z0-9_][A-Za-z0-9._-]{0,127}$/;
const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, v));
const L10 = Math.log10;

/** Every file under a directory, as paths relative to it, sorted. */
function listFiles(dir, rel = '') {
  const out = [];
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    const p = rel ? `${rel}/${e.name}` : e.name;
    if (e.isDirectory()) {
      if (e.name.startsWith('.')) throw new Error(`dot dir ${p}`);
      out.push(...listFiles(join(dir, e.name), p));
    } else if (e.isFile()) out.push(p);
    else throw new Error(`non-file ${p}`);
  }
  return out;
}

/** PNG width/height from the IHDR chunk, or null when not a PNG. */
function pngSize(buf) {
  if (buf.length < 24 || buf[0] !== 0x89 || buf[1] !== 0x50) return null;
  return { w: buf.readUInt32BE(16), h: buf.readUInt32BE(20) };
}

// --- 1. dashboard_files ---
const dashDir = join(outDir, 'dashboard');
const dashFiles = listFiles(dashDir).sort();
const dashSizes = dashFiles.map((f) => statSync(join(dashDir, f)).size);
const dashTotal = dashSizes.reduce((a, b) => a + b, 0);
const badNames = dashFiles.filter((f) => !PLAIN.test(f.split('/').pop()));
check(
  'dashboard_files/shape',
  dashFiles.includes('index.html') && dashFiles.some((f) => f.endsWith('.css')) && dashFiles.some((f) => f.endsWith('.js')) &&
    dashFiles.length <= 400 && dashTotal <= 4 * 1024 * 1024 && badNames.length === 0,
  `${dashFiles.length} files, ${dashTotal} bytes`,
);
// No network addresses: HTML attribute values, <style> bodies, CSS files,
// and JS import/export/require/dynamic-import specifiers.
function htmlHasNetwork(text) {
  const attrs = [...text.matchAll(/=\s*"([^"]*)"|=\s*'([^']*)'/g)].map((m) => m[1] ?? m[2]);
  const styles = [...text.matchAll(/<style[^>]*>([\s\S]*?)<\/style>/gi)].map((m) => m[1]);
  const imports = [...text.matchAll(/<script[^>]*>([\s\S]*?)<\/script>/gi)].flatMap((m) =>
    [...m[1].matchAll(/import\s+[^'"]*['"]([^'"]+)['"]|import\s*\(\s*['"]([^'"]+)['"]/g)].map((x) => x[1] ?? x[2]));
  return [...attrs, ...styles, ...imports].some((v) => /^https?:\/\//.test(v.trim()));
}
function jsHasNetwork(text) {
  const specs = [...text.matchAll(/(?:import\s+[^'"]*from\s*|export\s+[^'"]*from\s*|require\s*\(\s*|import\s*\(\s*)['"]([^'"]+)['"]/g)].map((m) => m[1]);
  return specs.some((s) => /^https?:\/\//.test(s));
}
let netOffender = null;
for (const f of dashFiles) {
  const text = readFileSync(join(dashDir, f), 'utf8');
  const hit = f.endsWith('.html') ? htmlHasNetwork(text) : f.endsWith('.css') ? /https?:\/\//.test(text) : f.endsWith('.js') ? jsHasNetwork(text) : false;
  if (hit) netOffender = f;
}
check('dashboard_files/no-network', netOffender === null, netOffender ? `offender: ${netOffender}` : 'no http(s) in attributes, CSS or import specifiers');
check('dashboard/source-under-64k', dashTotal < 65536, `${dashTotal} bytes total`);

// --- 2. board_file ---
const boardPath = join(outDir, 'board.json');
const boardBytes = statSync(boardPath).size;
const boardDoc = JSON.parse(readFileSync(boardPath, 'utf8'));
const rows = Array.isArray(boardDoc) ? boardDoc : boardDoc.rows;
let boardOk = Array.isArray(rows) && rows.length >= 100 && rows.length <= 4000 && boardBytes <= 8 * 1024 * 1024;
let boardWhy = `${rows.length} rows, ${boardBytes} bytes`;
for (const r of rows) {
  if (!bySlug.has(r.slug)) { boardOk = false; boardWhy = `unknown slug ${r.slug}`; break; }
  if (typeof r.name !== 'string' || r.name.length === 0) { boardOk = false; boardWhy = `empty name ${r.slug}`; break; }
  if (!Number.isInteger(r.rank) || r.rank < 1) { boardOk = false; boardWhy = `bad rank ${r.slug}`; break; }
  if (!Number.isInteger(r.implied_value_usd) || r.implied_value_usd < 1 || r.implied_value_usd > 1e14) { boardOk = false; boardWhy = `bad value ${r.slug}`; break; }
  if (!Array.isArray(r.farm_steps)) { boardOk = false; boardWhy = `no farm_steps ${r.slug}`; break; }
}
check('board_file', boardOk, boardWhy);

// --- 3. sorted_by_value ---
const ranks = rows.map((r) => r.rank).sort((a, b) => a - b);
const ranksOk = ranks.every((r, i) => r === i + 1);
const byRank = [...rows].sort((a, b) => a.rank - b.rank);
const sortedOk = byRank.every((r, i) => i === 0 || r.implied_value_usd <= byRank[i - 1].implied_value_usd);
const allEqual = new Set(rows.map((r) => r.implied_value_usd)).size === 1;
check('sorted_by_value', ranksOk && sortedOk && !(rows.length >= 2 && allEqual),
  `ranks 1..${rows.length}: ${ranksOk}, non-increasing: ${sortedOk}`);

// --- 4. coverage ---
const missing = [...watch].filter((w) => !rows.some((r) => r.slug === w));
check('coverage', missing.length === 0, `${watch.size}/${watch.size} watchlist slugs present`);

// --- 5. farm_steps ---
let stepsOk = true;
let stepsWhy = '';
for (const r of rows) {
  if (r.farm_steps.length !== 8) { stepsOk = false; stepsWhy = `${r.slug}: ${r.farm_steps.length} steps, want 8`; break; }
  for (const s of r.farm_steps) {
    const t = s.trim();
    if (t.length < 20 || t.length > 600) { stepsOk = false; stepsWhy = `${r.slug}: step of ${t.length} chars`; break; }
  }
  if (!stepsOk) break;
}
check('farm_steps', stepsOk, stepsWhy || `${rows.length} rows x 8 steps, all 20-600 chars`);

// --- 6. screenshots ---
const shotsDir = join(outDir, 'screenshots');
const shots = readdirSync(shotsDir, { withFileTypes: true }).filter((e) => e.isFile() && !e.name.startsWith('.')).map((e) => e.name).sort();
let shotsOk = shots.length >= 3 && shots.length <= 4;
let shotsWhy = `${shots.length} images`;
for (const name of shots) {
  const buf = readFileSync(join(shotsDir, name));
  if (!PLAIN.test(name)) { shotsOk = false; shotsWhy = `bad name ${name}`; break; }
  if (buf.length > 512 * 1024) { shotsOk = false; shotsWhy = `${name} is ${buf.length} bytes`; break; }
  const size = pngSize(buf);
  if (!size) { shotsOk = false; shotsWhy = `${name} is not a PNG`; break; }
  const long = Math.max(size.w, size.h), short = Math.min(size.w, size.h);
  if (long > 1440 || short < 800) { shotsOk = false; shotsWhy = `${name} is ${size.w}x${size.h}`; break; }
  shotsWhy += `, ${name} ${size.w}x${size.h} ${buf.length}B`;
}
check('screenshots', shotsOk, shotsWhy);

// --- 7. dossier_matches ---
const dossierBytes = readFileSync(join(outDir, 'dossier.json'));
let dossierOk = false;
let dossierWhy = '';
try {
  const rebuilt = buildDossier(outDir, { text_max_bytes: 65536 });
  dossierOk = Buffer.compare(Buffer.from(rebuilt), dossierBytes) === 0 && dossierBytes.length <= 1.5 * 1024 * 1024;
  dossierWhy = `${dossierBytes.length} bytes, byte-identical to buildDossier: ${Buffer.compare(Buffer.from(rebuilt), dossierBytes) === 0}`;
} catch (err) {
  dossierWhy = `buildDossier threw: ${err.message}`;
}
check('dossier_matches', dossierOk, dossierWhy);

// --- extras: the entry's own invariants ---
const preToken = rows.every((r) => r.mcap_usd === null && r.gecko_id === null && r.symbol === null);
check('board/208-pre-token', rows.length === 208 && preToken, `${rows.length} rows, all pre-token: ${preToken}`);

const VERSION_TAIL = /\s(v\d+(\.\d+)*|\d+\.\d+(\.\d+)*)$/i;
const versioned = rows.filter((r) => VERSION_TAIL.test(r.name));
const baseOf = (name) => name.replace(VERSION_TAIL, '');
const baseSeen = new Map();
let familyDup = null;
for (const r of rows) {
  const b = baseOf(r.name);
  if (baseSeen.has(b) && baseSeen.get(b) !== r.slug) familyDup = `${baseSeen.get(b)} vs ${r.slug}`;
  baseSeen.set(b, r.slug);
}
const watchVersioned = rows.filter((r) => r.watchlist && VERSION_TAIL.test(r.name));
check('board/version-families', versioned.length >= 10 && familyDup === null && watchVersioned.length === 0,
  `${versioned.length} versioned rows ranked, no family counted twice${familyDup ? `: ${familyDup}` : ''}, no watchlist row version-tailed`);

const compsOk = rows.every((r) => Array.isArray(r.comparables) && r.comparables.length === 5 && r.comparables.every((c) => bySlug.has(c.slug) && bySlug.get(c.slug).mcap_usd > 0));
check('board/5-comparables', compsOk, 'every row carries 5 live comparables');

const intervalsOk = rows.every((r) =>
  Array.isArray(r.interval_50) && Array.isArray(r.interval_80) &&
  r.interval_50[0] <= r.implied_value_usd && r.implied_value_usd <= r.interval_50[1] &&
  r.interval_80[0] <= r.implied_value_usd && r.implied_value_usd <= r.interval_80[1] &&
  r.interval_80[0] <= r.interval_50[0] && r.interval_50[1] <= r.interval_80[1]);
check('board/intervals-sane', intervalsOk, '50% inside 80%, both contain the value');

// Recompute every row from the published fit, exactly as the page does.
// data.js is one assignment of a JSON literal; parse the literal, no eval.
const dataText = readFileSync(join(outDir, 'data.js'), 'utf8');
const RADAR = JSON.parse(dataText.slice('window.RADAR = '.length).replace(/;\s*$/, ''));
const offsets = new Map(RADAR.model.offsets.map((o) => [o.category, o.offset]));

/** The fitted value for a protocol record, from the published parameters. */
function fittedValue(rec, asOf) {
  const m = RADAR.model;
  const growth = 1 + clamp(rec.change_7d ?? 0, m.growth_clamp[0], m.growth_clamp[1]) / 100 * m.growth_weight;
  let ageDays = typeof rec.age_days === 'number' ? rec.age_days : null;
  if (ageDays === null && rec.listed_at) {
    const listedMs = Date.parse(`${rec.listed_at}T00:00:00Z`);
    const asOfMs = Date.parse(`${asOf}T00:00:00Z`);
    ageDays = Number.isFinite(listedMs) ? Math.max(0, Math.floor((asOfMs - listedMs) / 86400000)) : null;
  }
  const age = ageDays === null ? m.unknown_age_days : ageDays;
  const season = 1 + m.age_amp * (clamp(age, 0, m.age_cap_days) / m.age_cap_days - 0.5);
  const key = rec.category === null ? '(uncategorised)' : rec.category;
  const logValue = m.intercept + m.slope * L10(rec.tvl_usd) + (offsets.get(key) ?? 0) + L10(growth) + L10(season);
  return clamp(Math.round(Math.pow(10, logValue)), 1, 1e14);
}

let recomputed = 0;
let recomputeBad = null;
for (const r of rows) {
  const value = fittedValue(r, RADAR.meta.as_of);
  const b = RADAR.backtest.bands;
  const lo50 = clamp(Math.round(value * Math.pow(10, b.q25)), 1, 1e14);
  const hi50 = clamp(Math.round(value * Math.pow(10, b.q75)), 1, 1e14);
  const lo80 = clamp(Math.round(value * Math.pow(10, b.q10)), 1, 1e14);
  const hi80 = clamp(Math.round(value * Math.pow(10, b.q90)), 1, 1e14);
  if (value === r.implied_value_usd && lo50 === r.interval_50[0] && hi50 === r.interval_50[1] && lo80 === r.interval_80[0] && hi80 === r.interval_80[1]) recomputed++;
  else if (!recomputeBad) recomputeBad = `${r.slug}: recomputed ${value} vs board ${r.implied_value_usd}`;
}
check('recompute/exact', recomputed === rows.length, `${recomputed}/${rows.length} rows match value + both intervals`);

// Comparables' fitted values recompute too.
let compBad = null;
let compChecked = 0;
for (const r of rows) {
  for (const c of r.comparables) {
    const fitted = fittedValue(bySlug.get(c.slug), RADAR.meta.as_of);
    compChecked++;
    if (fitted !== c.fitted_value_usd && !compBad) compBad = `${r.slug}/${c.slug}: recomputed ${fitted} vs ${c.fitted_value_usd}`;
  }
}
check('recompute/comparables', compBad === null, compBad ?? `${compChecked} comparable fits match`);

const shipped = RADAR.candidates.filter((c) => c.shipped);
const naive = RADAR.candidates.filter((c) => c.name.indexOf('Naive') === 0);
const pairedOk = RADAR.candidates.every((c) => c.shipped ? c.pairedT === null : typeof c.pairedT === 'number');
const effectOk = RADAR.candidates.every((c) =>
  c.shipped
    ? c.cohensD === null && c.ci95 === null
    : typeof c.cohensD === 'number' && Array.isArray(c.ci95) && c.ci95.length === 2 && c.ci95[0] <= c.ci95[1]);
// The fold-win share is the new diagnostic: null on the shipped row, a
// share in [0, 1] on every alternative, so the table shows how often each
// challenger actually beats the shipped fit fold by fold.
const winOk = RADAR.candidates.every((c) =>
  c.shipped ? c.winShare === null : typeof c.winShare === 'number' && c.winShare >= 0 && c.winShare <= 1);
check('research/bake-off-45', RADAR.candidates.length === 45 && shipped.length === 1 && naive.length === 1 && pairedOk && effectOk && winOk,
  `${RADAR.candidates.length} candidates, shipped: ${shipped[0]?.name ?? 'none'}, paired t + Cohen's d + 95% CI + fold-win share on every alternative`);

check('research/holdouts', RADAR.backtest.loco && RADAR.backtest.band_holdout && RADAR.calibration.length > 0,
  `LOCO MAE ${RADAR.backtest.loco.mae.toFixed(3)}, band MAE ${RADAR.backtest.band_holdout.mae.toFixed(3)}, ${RADAR.calibration.length} calibration rows`);

const splitsOk = Array.isArray(RADAR.harder_splits) && RADAR.harder_splits.length >= 5 && RADAR.harder_splits.length <= 6 &&
  RADAR.harder_splits.some((s) => s.shipped) && RADAR.harder_splits.every((s) => s.loco_mae > 0 && s.band_mae > 0);
check('research/harder-splits', splitsOk, `${RADAR.harder_splits?.length ?? 0} closest specs with category + band holdouts`);

const snapPre = snap.protocols.filter((p) => p.mcap_usd === null && p.gecko_id === null && p.symbol === null).length;
const snapPartial = snap.protocols.filter((p) => p.mcap_usd === null && (p.gecko_id !== null || p.symbol !== null)).length;
const comp = RADAR.composition;
const compOk = comp && comp.pre_token_total === snapPre && comp.partial_token_records === snapPartial &&
  comp.version_tail_admitted === versioned.length && comp.version_tail_deduped.every((s) => !rows.some((r) => r.slug === s));
check('research/composition', compOk, `audit counts match the snapshot: ${snapPre} pre-token, ${snapPartial} partial records, ${versioned.length} versioned admitted`);

// The selection rule's outcome is recorded and consistent with the model.
const sel = RADAR.selection;
const selOk = sel && typeof sel.switched === 'boolean' && typeof sel.note === 'string' && sel.note.length > 20 &&
  sel.params.shrinkPrior === RADAR.model.shrink_prior && sel.params.trimSd === RADAR.model.trim_sd &&
  sel.params.trimRounds === RADAR.model.trim_rounds && sel.params.growthWeight === RADAR.model.growth_weight &&
  sel.params.ageAmp === RADAR.model.age_amp;
check('research/selection', selOk, sel ? `switched=${sel.switched}, winner: ${sel.winner_name}` : 'no selection record');

// Interval coverage is reported and sane: the 50% band should hold about half the time, the 80% most of it.
const covOk = typeof RADAR.backtest.coverage50 === 'number' && typeof RADAR.backtest.coverage80 === 'number' &&
  RADAR.backtest.coverage50 >= 0.3 && RADAR.backtest.coverage50 <= 0.7 &&
  RADAR.backtest.coverage80 >= 0.6 && RADAR.backtest.coverage80 <= 0.95;
check('research/coverage', covOk, `50% band held ${Math.round(RADAR.backtest.coverage50 * 100)}%, 80% band held ${Math.round(RADAR.backtest.coverage80 * 100)}% out of sample`);

// Every comparable's trimmed flag must match the model's trimmed set.
const trimmedSet = new Set(RADAR.model.trimmed_slugs);
let trimBad = null;
for (const r of rows) for (const c of r.comparables) {
  if (c.trimmed !== trimmedSet.has(c.slug) && !trimBad) trimBad = `${r.slug}/${c.slug}`;
}
check('board/trimmed-flags', trimBad === null, trimBad ?? 'all comparable trimmed flags match the fit');

// Gas wording follows the first chain's tier; no generic phrase survives.
const CHEAP = new Set(['Solana', 'Sui', 'Aptos', 'Tron', 'TON', 'Cardano', 'Near', 'Cosmos', 'Osmosis', 'Injective', 'Sei', 'Celestia', 'Kava', 'Terra', 'dYdX', 'Canton', 'Proton', 'PlatON', 'Noble', 'Bitcoincash', 'Stellar', 'Ripple', 'Algorand', 'Zcash', 'Doge', 'Litecoin', 'XION', 'Aleo']);
let gasBad = null;
let costTimeBad = null;
for (const r of rows) {
  const c1 = r.chains[0];
  const want = c1 === 'Ethereum' ? 'about $3–12 of gas' : CHEAP.has(c1) ? 'a few cents of fees' : 'under $1 of gas';
  const wantExit = c1 === 'Ethereum' ? 'exit gas, about $3–10' : CHEAP.has(c1) ? 'exit gas, a few cents' : 'exit gas, under $1';
  for (const s of r.farm_steps) {
    if (!s.includes('Cost:') || !s.includes('Time:')) { costTimeBad = `${r.slug}: step without Cost/Time`; break; }
    const gm = s.match(/about \$[0-9–-]+ of gas|a few cents of fees/);
    if (gm && gm[0] !== want) { gasBad = `${r.slug} (${c1}): ${gm[0]}`; break; }
    const em = s.match(/exit gas, [^.]+/);
    if (em && em[0] !== wantExit) { gasBad = `${r.slug} (${c1}): ${em[0]}`; break; }
  }
  if (gasBad || costTimeBad) break;
}
check('board/gas-tiers', gasBad === null, gasBad ?? 'every gas phrase matches its first chain tier');
check('farm_steps/cost-time', costTimeBad === null, costTimeBad ?? 'every step carries a Cost and a Time');
check('screenshots/count-4', shots.length === 4, `${shots.length} screenshots (board, detail, filtered, research)`);

console.log(`\n${passes} passed, ${failures} failed`);
process.exit(failures === 0 ? 0 : 1);
