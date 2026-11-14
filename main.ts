// Launch Radar v3: the token-radar-01 entrypoint (Node 22, standard library only).
//
// Reads the sealed snapshot, fits the power-law model in lib/model.ts to the
// snapshot's own live protocols, backtests it against fourteen alternatives,
// and writes the whole entry to the output directory: board.json, data.js,
// the dashboard, the screenshots, and dossier.json last — the gate
// re-derives the dossier byte-for-byte, so the vendored library call is the
// last write and nothing after it touches the output tree.
//
// In the grader's container the snapshot is /input/snapshot.json and the
// output is /output. Outside it:
//
//   mkdir -p out && MAKEFUN_OUTPUT_DIR=out node main.ts --input <snapshot.json|dir>
//
// Fully deterministic: no clock, no randomness, no network. Two runs over
// the same snapshot write identical bytes.

import { copyFileSync, existsSync, mkdirSync, readFileSync, readdirSync, statSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { boardProblem, buildAll, dataScript, parseSnapshot } from './lib/model.ts';
import { buildDossier } from './vendor/makefun-board.ts';

const ROOT = dirname(fileURLToPath(import.meta.url));

const TEXT_CAP = 65_536;
const SHOT_CAPS = { max: 4, max_bytes: 524_288 };
const DASH_CAPS = { max_files: 400, max_bytes: 4_194_304 };
const SHOT_NAME = /^[A-Za-z0-9_][A-Za-z0-9._-]{0,127}$/;

function fail(message: string): never {
  process.stderr.write(`launch-radar: ${message}\n`);
  process.exit(1);
}

/** `--flag value` or `--flag=value` from argv, else the fallback. */
function flag(name: string, fallback: string | undefined): string | undefined {
  const argv = process.argv.slice(2);
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]!;
    if (a === `--${name}` && i + 1 < argv.length) return argv[i + 1];
    if (a.startsWith(`--${name}=`)) return a.slice(name.length + 3);
  }
  return fallback;
}

const inputArg = flag('input', '/input')!;
const inputPath = inputArg.endsWith('.json') ? inputArg : join(inputArg, 'snapshot.json');
if (!existsSync(inputPath)) {
  fail(`no snapshot at ${inputPath}: pass --input <snapshot.json|directory> or mount the sealed /input`);
}
const outDir = flag('output', process.env.MAKEFUN_OUTPUT_DIR ?? '/output')!;

const snap = parseSnapshot(readFileSync(inputPath, 'utf8'));
const { board, dash } = buildAll(snap);
const problem = boardProblem(board, snap);
if (problem !== null) fail(`the model wrote a board the gate refuses: ${problem}`);

mkdirSync(outDir, { recursive: true });
writeFileSync(join(outDir, 'board.json'), `${JSON.stringify({ rows: board })}\n`);
writeFileSync(join(outDir, 'data.js'), dataScript(dash));

/** Copy a directory tree of regular files, skipping dot-names, in sorted order. */
function copyTree(from: string, to: string, rel = ''): string[] {
  if (!existsSync(from)) return [];
  mkdirSync(to, { recursive: true });
  const done: string[] = [];
  for (const name of readdirSync(from).sort()) {
    if (name.startsWith('.')) continue;
    const src = join(from, name);
    const dst = join(to, name);
    const st = statSync(src);
    if (st.isDirectory()) done.push(...copyTree(src, dst, rel === '' ? name : `${rel}/${name}`));
    else if (st.isFile()) {
      copyFileSync(src, dst);
      done.push(rel === '' ? name : `${rel}/${name}`);
    }
  }
  return done;
}

const dashFiles = copyTree(join(ROOT, 'dashboard'), join(outDir, 'dashboard'));
if (!dashFiles.includes('index.html')) fail('dashboard/ holds no index.html');
const shots = copyTree(join(ROOT, 'screenshots'), join(outDir, 'screenshots'));
if (shots.length < 3) fail(`screenshots/ holds ${shots.length} images: hand in 3, the board, a detail view and a filtered view`);
for (const name of shots) {
  if (!SHOT_NAME.test(name)) fail(`screenshots/${name}: names are letters, digits and . _ -, 1 to 128 characters`);
}

// Last write: the dossier, from the finished output tree.
writeFileSync(join(outDir, 'dossier.json'), buildDossier(outDir, { text_max_bytes: TEXT_CAP, screenshots: SHOT_CAPS, dashboard: DASH_CAPS }));

const best = dash.candidates[0]!;
process.stdout.write(
  `launch-radar: ${snap.protocols.length} protocols, ${snap.watchlist.length} on the watchlist, ${board.length} board rows (${dash.meta.early_size} early), ${dash.live.length} live shown apart\n` +
    `launch-radar: fit log10(mcap) = ${dash.model.intercept.toFixed(4)} + ${dash.model.slope.toFixed(4)} * log10(TVL) on ${dash.model.kept_count} live protocols (${dash.model.trimmed_count} trimmed), R2 = ${dash.model.r_squared}, LOO median error ${Math.round(dash.backtest.medianPct)}%\n` +
    `launch-radar: bake-off winner by LOO MAE: ${best.name} (${best.summary.mae.toFixed(3)}); shipped spec MAE ${dash.backtest.mae.toFixed(3)}\n` +
    `launch-radar: wrote ${join(outDir, 'board.json')}, ${join(outDir, 'data.js')}, dashboard (${dashFiles.length} files), screenshots (${shots.length}) and dossier.json\n`,
);
