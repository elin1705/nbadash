// Walk-forward calibration test of the projection model on the real game logs.
// Run: node scripts/backtest.js   (writes docs/data/calibration.json for the Model check tab)
const fs = require('fs');
const path = require('path');
const M = require('../docs/model.js');

const root = path.join(__dirname, '..');
const logs = JSON.parse(fs.readFileSync(path.join(root, 'docs/data/gamelogs.json'), 'utf8'));
const cols = logs.cols;
const toGames = (arr, season) => (arr || []).map((r) => {
  const o = { season };
  cols.forEach((c, i) => (o[c] = r[i]));
  return o;
});

const players = {};
const ids = new Set([...Object.keys(logs.current || {}), ...Object.keys(logs.previous || {})]);
for (const pid of ids) {
  players[pid] = [...toGames(logs.current[pid], 'current'), ...toGames(logs.previous[pid], 'previous')];
}

const t0 = Date.now();
const res = M.backtest(players);
const pct = (x) => (x == null ? '  -  ' : (x * 100).toFixed(1).padStart(5) + '%');

console.log(`Backtest: ${res.all.n.toLocaleString()} predictions in ${((Date.now() - t0) / 1000).toFixed(1)}s\n`);
for (const [name, r] of [['Main lines (near projection)', res.main], ['Low alt lines (filler legs)', res.alt]]) {
  console.log(`${name}: n=${r.n.toLocaleString()}  Brier model=${r.brier.toFixed(4)}  baseline(L10 hit rate)=${r.brierBaseline.toFixed(4)}`);
  console.log('  predicted   actual      n');
  for (const b of r.buckets) if (b.n) console.log(`  ${pct(b.predicted)}    ${pct(b.actual)}  ${String(b.n).padStart(6)}`);
  console.log();
}
console.log(`Model said >=95%: n=${res.safe.n}, predicted ${pct(res.safe.predicted)}, actual ${pct(res.safe.actual)}`);
console.log('\nBy stat (main lines): ' + Object.entries(res.byStat).map(([s, r]) => `${s} ${r.brier.toFixed(3)} vs ${r.brierBaseline.toFixed(3)}`).join(' | '));

// Out-of-sample check: settings were tuned on last season, so score this season on its own.
const cur = M.backtest(players, { outcomeSeason: 'current' });
res.validation = { season: 'this season', safe: cur.safe, brier: cur.all.brier, brierBaseline: cur.all.brierBaseline, n: cur.all.n };
console.log(`\nThis season only (not used for tuning): "95%+" said ${pct(cur.safe.predicted)}, hit ${pct(cur.safe.actual)} (n=${cur.safe.n})`);

res.generated = new Date().toISOString();
fs.writeFileSync(path.join(root, 'docs/data/calibration.json'), JSON.stringify(res));
