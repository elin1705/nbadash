# NBA Props Dash

A free, self-updating NBA dashboard for player props.

**Live site:** https://elin1705.github.io/nbadash/

## What's in it
- **Today**: tonight's games (Melbourne time) and a player board ranked by matchup, with defence-vs-position ranks, L5/L10 trends and opportunity stats.
- **Players**: prop checker (enter a line and see hit rates for L5/L10/L20, season, home/away and vs the opponent), rebound and assist opportunities, shot zones vs the opponent's zone defence, defender matchups and head-to-head logs.
- **Teams & DvP**: what every defence allows to guards, forwards and centres, plus zone defence and pace.

- **Price it**: enter the bookie's over/under odds and get the margin-free book probability, the model's probability, edge, EV and quarter-Kelly stake, with the working shown. Teammates listed out are auto-adjusted using real "without" games.
- **Safe legs**: the highest bookie-style alt line for each player that the model rates 95%+ (adjustable), with fair odds and risk flags.
- **Model check**: walk-forward backtest showing how often "X%" actually hit.

## The model
`docs/model.js` holds every formula, and the site and the tests use the same file.
- Tests: `node --test tests/model.test.js`
- Backtest (rewrites `docs/data/calibration.json`): `node scripts/backtest.js`

## How it updates
`.github/workflows/update-data.yml` runs `scripts/fetch_data.py` twice a day (about 7am and 9pm Melbourne time), pulls stats from NBA.com, and commits the JSON into `docs/data/`. GitHub Pages serves `docs/`.

Run it by hand: **Actions → Update NBA data → Run workflow**.

## If NBA.com blocks GitHub
Run the fetch on your own computer and push the data:
```
pip install -r requirements.txt
python scripts/fetch_data.py
git add docs/data && git commit -m "Update data" && git push
```
