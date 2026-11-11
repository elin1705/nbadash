// Walk-forward test of the opponent (defence-vs-position) adjustment.
// Rebuilds per-minute DvP each day from earlier games only, then compares prediction error
// with and without the adjustment, across several shrink strengths.
// Run: node scripts/opp_backtest.js
const fs = require('fs');
const path = require('path');
const M = require('../docs/model.js');

const root = path.join(__dirname, '..');
const read = (f) => JSON.parse(fs.readFileSync(path.join(root, 'docs/data', f), 'utf8'));
const logs = read('gamelogs.json');
const players = read('players.json');
const grpOf = {};
players.forEach((p) => (grpOf[p.id] = p.grp));
const cols = logs.cols;
const toGames = (arr, season) => (arr || []).map((r) => { const o = { season }; cols.forEach((c, i) => (o[c] = r[i])); return o; });

const byPlayer = {};
for (const pid of new Set([...Object.keys(logs.current), ...Object.keys(logs.previous)])) {
  byPlayer[pid] = [...toGames(logs.current[pid], 'current'), ...toGames(logs.previous[pid], 'previous')];
}

// ---- cumulative DvP snapshots by date: season -> date -> {team:{grp:{stat sums, MIN, games:Set}}}
const KEYS = ['pts', 'reb', 'ast', 'fg3m', 'stl', 'blk', 'tov', 'fga'];
const rows = [];
for (const [pid, games] of Object.entries(byPlayer)) {
  const grp = grpOf[pid];
  if (!grp) continue;
  for (const g of games) rows.push({ pid, grp, ...g });
}
rows.sort((a, b) => (a.date < b.date ? -1 : 1));

const snap = { current: {}, previous: {} }; // season -> date -> frozen totals BEFORE that date
const running = { current: {}, previous: {} };
let i = 0;
const dates = [...new Set(rows.map((r) => r.season + '|' + r.date))].sort((a, b) => (a.split('|')[1] < b.split('|')[1] ? -1 : 1));
for (const sd of dates) {
  const [season, date] = sd.split('|');
  // freeze a copy of totals before this date
  snap[season][date] = JSON.parse(JSON.stringify(running[season], (k, v) => (v instanceof Set ? v.size : v)));
  while (i < rows.length && rows[i].date === date && rows[i].season === season) {
    const r = rows[i++];
    const t = (running[season][r.opp] = running[season][r.opp] || {});
    const x = (t[r.grp] = t[r.grp] || { MIN: 0, games: new Set() });
    x.MIN += r.min; x.games.add(r.gid);
    for (const k of KEYS) x[k] = (x[k] || 0) + (r[k] || 0);
  }
  // rows may interleave seasons on the same date ordering; catch stragglers
  while (i < rows.length && rows[i].date === date) {
    const r = rows[i++];
    const t = (running[r.season][r.opp] = running[r.season][r.opp] || {});
    const x = (t[r.grp] = t[r.grp] || { MIN: 0, games: new Set() });
    x.MIN += r.min; x.games.add(r.gid);
    for (const k of KEYS) x[k] = (x[k] || 0) + (r[k] || 0);
  }
}

function makeOppFn(shrink, cap) {
  return (pid, game, stat) => {
    const grp = grpOf[pid];
    const s = snap[game.season] && snap[game.season][game.date];
    if (!grp || !s || !s[game.opp] || !s[game.opp][grp]) return 1;
    const d = s[game.opp][grp];
    const gp = d.games || 0;
    const k = gp / (gp + shrink);
    let num = 0, den = 0;
    for (const p of M.STATS[stat].parts) {
      let lgS = 0, lgM = 0;
      for (const t of Object.values(s)) if (t[grp]) { lgS += t[grp][p] || 0; lgM += t[grp].MIN; }
      if (!lgS || !d.MIN) continue;
      const raw = ((d[p] || 0) / d.MIN) / (lgS / lgM);
      let f = 1 + (raw - 1) * k;
      if (cap) f = Math.min(1 + cap, Math.max(1 - cap, f));
      num += f; den += 1;
    }
    return den ? num / den : 1;
  };
}

const configs = [['no opponent adjustment', null], ['shrink 15 (old)', [15, 0]], ['shrink 30', [30, 0]],
  ['shrink 60', [60, 0]], ['shrink 30, cap ±10%', [30, 0.1]], ['shrink 60, cap ±8%', [60, 0.08]]];
const results = [];
for (const [name, cfg] of configs) {
  const opts = { stats: ['PTS', 'REB', 'AST', 'FG3M', 'PRA'] };
  if (cfg) opts.oppFn = makeOppFn(cfg[0], cfg[1]);
  const r = M.backtest(byPlayer, opts);
  results.push({ name, cfg, brier: r.main.brier, safe: r.safe, byStat: r.byStat });
  console.log(`${name.padEnd(26)} Brier(main) ${r.main.brier.toFixed(5)}  REB ${r.byStat.REB.brier.toFixed(5)}  "95%+" said ${(r.safe.predicted * 100).toFixed(1)} hit ${(r.safe.actual * 100).toFixed(1)}`);
}
fs.writeFileSync(path.join(root, 'docs/data/opp_backtest.json'), JSON.stringify(results));
