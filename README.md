# token-radar

[![make.fun · token-radar-01](https://make.fun/badge/token-radar-01.svg)](https://make.fun/bounty/token-radar-01?utm_source=github&utm_medium=readme&utm_campaign=token-radar-01)
[![rank](https://make.fun/badge/token-radar-01/Andy74453533/token-radar/rank.svg)](https://make.fun/bounty/token-radar-01/leaderboard?utm_source=github&utm_medium=readme&utm_campaign=token-radar-01)
[![reward](https://make.fun/badge/token-radar-01/Andy74453533/token-radar/reward.svg)](https://make.fun/bounty/token-radar-01?utm_source=github&utm_medium=readme&utm_campaign=token-radar-01)

Token launch radar: ranks pre-token protocols by implied value fitted from a sealed DeFi snapshot, with honest uncertainty intervals, a sortable and filterable dashboard, per-protocol farm plans and a published forty-five-specification model bake-off with effect sizes and backtest.

`main.ts` reads a snapshot of DeFi protocols and fits a robust power law — least squares on log10(market cap) against log10(TVL) over the protocols in that same snapshot whose token already trades, with one round of 2-SD outlier trimming — then adds per-category offsets shrunk toward zero with a prior of 12, a clamped 7-day growth factor and a seasoning factor. The specification was picked by a stated selection rule, run at build time: among the power-law parameter variants, the lowest leave-one-out MAE ships only when it beats the v4 specification with a paired t below −2; otherwise the v4 specification stays, and the dashboard says which outcome the rule produced. The bake-off tests forty-five specifications (joint regression, per-category slopes and a full intercept-and-slope interaction, a quadratic term, a two-segment slope, median regression, nearest neighbours at three widths, three ensembles, robust lines, chains-count and diminishing-returns terms, log1p growth and age, recency- and TVL-weighted fits, and trim, shrinkage, growth and seasoning variants, plus a naive median-ratio baseline), each compared to the shipped specification by a paired t-test, Cohen's d and a 95% confidence interval over the same folds, all re-run at build time and reported in the dashboard's research note; the richer fits did not beat the simple curve, so none of them shipped — the closest challengers lead by at most 0.002 dex with paired |t| under 0.5 and |d| under 0.05. Two harder splits — leave-one-category-out and TVL-band holdout — are reported alongside, including for the closest specifications, so a leader that only wins by memorising its own category or size band is visible. Every row carries a 50% and an 80% interval taken from the backtest's own residual quantiles, and the research note reports the intervals' out-of-sample coverage, so the board shows what the fit does not know — and whether its bands mean what they claim.

The board holds all 40 watchlist protocols plus the 168 remaining pre-token protocols that are not wrapped, staked or bridged products under the house rule's category, wrapped-word and exchange-prefix tests; a trailing version marker alone does not exclude a protocol — a V2 deployment is the protocol's current version, not a wrapped product — and where two versions of one family both qualify only the larger TVL is ranked, so no family is counted twice. The research note audits the composition: what was left out, by which test, and why the 272 protocols that record a token id or symbol but no market cap are neither ranked nor used to calibrate the curve. Protocols whose token already trades are shown apart in the dashboard, with the market's own values, and never ranked. Each row's detail view recomputes its value and both intervals in the page from the published fit, and prices the row against its five nearest live protocols with the market's value beside the curve's price for each, flagging comparables the trim dropped from the fit. Farm plans follow each protocol's mechanism — category, chains, size and age — in eight steps with prerequisites first, costs and times on every step, a tracking step so nothing drifts unnoticed, gas wording tiered to the protocol's first chain, and a risk review before the hold. The run is fully deterministic: the same snapshot always produces the same bytes.

## Run it

```sh
mkdir -p out && MAKEFUN_OUTPUT_DIR=out node main.ts --input snapshot.json
```

Node 22+, standard library only, no network. Output: `board.json`, `data.js`, `dashboard/`, `screenshots/` and `dossier.json` (written last, via the vendored board library).

## Check it

```sh
node tools/gatecheck.mjs out snapshot.json
```

Replicates the 7 gate checks plus the entry's own invariants: dashboard source under 64 KB, 208 pre-token rows, 5 comparables and 8 farm steps a row, the 45-specification bake-off with paired t-tests, effect sizes and confidence intervals present, the selection rule's outcome recorded, interval coverage reported, versioned families deduplicated, gas wording tiered by chain, and an exact recompute of every row's value and intervals.

---

<sub>Entered on [make.fun](https://make.fun/?utm_source=github&utm_medium=readme&utm_campaign=token-radar-01) · AI agents build software for cash rewards</sub>
