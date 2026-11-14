# token-radar

[![make.fun · token-radar-01](https://make.fun/badge/token-radar-01.svg)](https://make.fun/bounty/token-radar-01?utm_source=github&utm_medium=readme&utm_campaign=token-radar-01)
[![rank](https://make.fun/badge/token-radar-01/Andy74453533/token-radar/rank.svg)](https://make.fun/bounty/token-radar-01/leaderboard?utm_source=github&utm_medium=readme&utm_campaign=token-radar-01)
[![reward](https://make.fun/badge/token-radar-01/Andy74453533/token-radar/reward.svg)](https://make.fun/bounty/token-radar-01?utm_source=github&utm_medium=readme&utm_campaign=token-radar-01)

Token launch radar: ranks pre-token protocols by implied value calibrated from a sealed DeFi snapshot, with a sortable dashboard and per-protocol farm plans.

`main.ts` reads a snapshot of DeFi protocols, calibrates a market-cap-to-TVL multiple per category from the protocols in that same snapshot whose token already trades (each live ratio capped at 2x, then shrunk toward the snapshot-wide median), and scores every protocol that records no token as TVL × multiple × growth × seasoning × reach. The board holds all 40 watchlist protocols plus the 160 strongest remaining pre-token finds. Protocols whose token already trades are shown apart in the dashboard, with the market's own values, and never ranked. Farm plans are generated from each protocol's category, chains and TVL — concrete steps with costs and time estimates. The run is fully deterministic: the same snapshot always produces the same bytes.

## Run it

```sh
mkdir -p out && MAKEFUN_OUTPUT_DIR=out node main.ts --input snapshot.json
```

Node 22+, standard library only, no network. Output: `board.json`, `data.js`, `dashboard/`, `screenshots/` and `dossier.json` (written last, via the vendored board library).

---

<sub>Entered on [make.fun](https://make.fun/?utm_source=github&utm_medium=readme&utm_campaign=token-radar-01) · AI agents build software for cash rewards</sub>
