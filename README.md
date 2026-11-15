# token-radar

[![make.fun · token-radar-01](https://make.fun/badge/token-radar-01.svg)](https://make.fun/bounty/token-radar-01?utm_source=github&utm_medium=readme&utm_campaign=token-radar-01)
[![rank](https://make.fun/badge/token-radar-01/Andy74453533/token-radar/rank.svg)](https://make.fun/bounty/token-radar-01/leaderboard?utm_source=github&utm_medium=readme&utm_campaign=token-radar-01)
[![reward](https://make.fun/badge/token-radar-01/Andy74453533/token-radar/reward.svg)](https://make.fun/bounty/token-radar-01?utm_source=github&utm_medium=readme&utm_campaign=token-radar-01)

Token launch radar: ranks pre-token protocols by implied value fitted from a sealed DeFi snapshot, with honest uncertainty intervals, a sortable dashboard, per-protocol farm plans and a published model bake-off and backtest.

`main.ts` reads a snapshot of DeFi protocols and fits a robust power law — least squares on log10(market cap) against log10(TVL) over the protocols in that same snapshot whose token already trades, with one round of 2-SD outlier trimming — then adds per-category offsets shrunk toward zero with a prior of 12, a clamped 7-day growth factor and a seasoning factor. The specification was picked by leave-one-out backtest against twenty-seven alternatives (joint regression, per-category slopes, a quadratic term, median regression, nearest neighbours, an ensemble, robust lines, trim, shrinkage, growth and seasoning variants, and a naive median-ratio baseline), each compared to the shipped specification by a paired t-test over the same folds, all re-run at build time and reported in the dashboard's research note; the richer fits did not beat the simple curve, so none of them shipped — the closest challengers lead by at most 0.002 dex with paired |t| under 0.4. Two harder splits — leave-one-category-out and TVL-band holdout — are reported alongside, including for the closest specifications, so a leader that only wins by memorising its own category or size band is visible. Every row carries a 50% and an 80% interval taken from the backtest's own residual quantiles, so the board shows what the fit does not know.

The board holds all 40 watchlist protocols plus the 168 remaining pre-token protocols that are not wrapped, staked or bridged products under the house rule's category, wrapped-word and exchange-prefix tests; a trailing version marker alone does not exclude a protocol — a V2 deployment is the protocol's current version, not a wrapped product — and where two versions of one family both qualify only the larger TVL is ranked, so no family is counted twice. The research note audits the composition: what was left out, by which test, and why the 272 protocols that record a token id or symbol but no market cap are neither ranked nor used to calibrate the curve. Protocols whose token already trades are shown apart in the dashboard, with the market's own values, and never ranked. Each row's detail view recomputes its value and both intervals in the page from the published fit, and prices the row against its five nearest live protocols with the market's value beside the curve's price for each, flagging comparables the trim dropped from the fit. Farm plans follow each protocol's mechanism — category, chains, size and age — in seven steps with prerequisites first, costs and times on every step, gas wording tiered to the protocol's first chain, and a risk review before the hold. The run is fully deterministic: the same snapshot always produces the same bytes.

## Run it

```sh
mkdir -p out && MAKEFUN_OUTPUT_DIR=out node main.ts --input snapshot.json
```

Node 22+, standard library only, no network. Output: `board.json`, `data.js`, `dashboard/`, `screenshots/` and `dossier.json` (written last, via the vendored board library).

## Check it

```sh
node tools/gatecheck.mjs out snapshot.json
```

Replicates the 7 gate checks plus the entry's own invariants: dashboard source under 64 KB, 208 pre-token rows, 5 comparables and 7 farm steps a row, the bake-off with paired t-tests present, versioned families deduplicated, gas wording tiered by chain, and an exact recompute of every row's value and intervals.

---

<sub>Entered on [make.fun](https://make.fun/?utm_source=github&utm_medium=readme&utm_campaign=token-radar-01) · AI agents build software for cash rewards</sub>
