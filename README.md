# token-radar

[![make.fun · token-radar-01](https://make.fun/badge/token-radar-01.svg)](https://make.fun/bounty/token-radar-01?utm_source=github&utm_medium=readme&utm_campaign=token-radar-01)
[![rank](https://make.fun/badge/token-radar-01/Andy74453533/token-radar/rank.svg)](https://make.fun/bounty/token-radar-01/leaderboard?utm_source=github&utm_medium=readme&utm_campaign=token-radar-01)
[![reward](https://make.fun/badge/token-radar-01/Andy74453533/token-radar/reward.svg)](https://make.fun/bounty/token-radar-01?utm_source=github&utm_medium=readme&utm_campaign=token-radar-01)

Token launch radar: ranks pre-token protocols by implied value fitted from a sealed DeFi snapshot, with a sortable dashboard, per-protocol farm plans and a published backtest.

`main.ts` reads a snapshot of DeFi protocols and fits a robust power law — least squares on log10(market cap) against log10(TVL) over the protocols in that same snapshot whose token already trades, with one round of 2-SD outlier trimming — then adds shrunk per-category offsets, a clamped 7-day growth factor and a seasoning factor. The whole pipeline is backtested leave-one-out at run time against a naive median-ratio baseline, and the dashboard publishes the fitted parameters, the offsets, the backtest and a log-log chart of the live market against the curve. The board holds all 40 watchlist protocols plus the 158 strongest remaining pre-token finds. Protocols whose token already trades are shown apart in the dashboard, with the market's own values, and never ranked. Farm plans are generated from each protocol's category mechanics, chains, TVL and age — concrete steps with costs and time estimates. The run is fully deterministic: the same snapshot always produces the same bytes.

## Run it

```sh
mkdir -p out && MAKEFUN_OUTPUT_DIR=out node main.ts --input snapshot.json
```

Node 22+, standard library only, no network. Output: `board.json`, `data.js`, `dashboard/`, `screenshots/` and `dossier.json` (written last, via the vendored board library).

---

<sub>Entered on [make.fun](https://make.fun/?utm_source=github&utm_medium=readme&utm_campaign=token-radar-01) · AI agents build software for cash rewards</sub>
