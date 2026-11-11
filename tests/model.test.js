// Run: node --test tests/model.test.js
const test = require('node:test');
const assert = require('node:assert/strict');
const M = require('../docs/model.js');

const close = (a, b, tol = 1e-3, msg) => assert.ok(Math.abs(a - b) <= tol, `${msg || ''} expected ${b}, got ${a}`);

test('implied probability & margin removal', () => {
  close(M.impliedProb(2.0), 0.5);
  close(M.impliedProb(1.87), 0.5348);
  const d = M.devig(1.87, 1.87);
  close(d.over, 0.5); close(d.under, 0.5); close(d.margin, 0.0695);
  const e = M.devig(1.5, 2.6); // 0.6667 / (0.6667 + 0.3846)
  close(e.over, 0.6342); close(e.over + e.under, 1, 1e-12);
  const one = M.devig(1.9, null);
  assert.equal(one.twoWay, false); close(one.over, 0.5263);
});

test('expected value, Kelly and fair odds', () => {
  close(M.expectedValue(0.56, 1.87), 0.0472);       // 0.56*0.87 - 0.44
  close(M.expectedValue(0.5, 2.0), 0);               // fair coin at fair odds
  close(M.expectedValue(0.5, 1.9, 0.1), 0.05);       // 0.5*0.9 - 0.4 (push refunds)
  close(M.kelly(0.56, 1.87), 0.0543);
  assert.ok(M.kelly(0.45, 2.0) < 0);                 // negative = no bet
  close(M.fairOdds(0.25), 4);
});

test('normal CDF', () => {
  close(M.normCdf(0), 0.5, 1e-7);
  close(M.normCdf(1.959964), 0.975, 1e-5);
  close(M.normCdf(-1), 0.158655, 1e-5);
  close(M.normCdf(110, 100, 10), 0.841345, 1e-5);
});

test('log-gamma', () => {
  close(M.lgamma(5), Math.log(24), 1e-9);
  close(M.lgamma(0.5), Math.log(Math.sqrt(Math.PI)), 1e-9);
  close(M.lgamma(20.5), 40.8315009745308, 1e-9); // matches Python math.lgamma
});

test('count distributions', () => {
  // Poisson(3): P(X<=2) = e^-3 (1 + 3 + 4.5)
  const p = M.lineProbs(2.5, 3, 3);
  close(p.under, Math.exp(-3) * 8.5, 1e-9);
  close(p.over + p.under + p.push, 1, 1e-9);
  // Negative binomial mean 4 var 8 -> r=4, p=0.5, P(0) = 0.5^4
  close(M.countPmf(0, 4, 8), 0.0625, 1e-9);
  // pmf sums to 1
  let s = 0; for (let k = 0; k < 400; k++) s += M.countPmf(k, 25, 60);
  close(s, 1, 1e-6);
  // integer line gives a push probability
  const q = M.lineProbs(3, 3, 3);
  close(q.push, Math.exp(-3) * 27 / 6, 1e-9);
  close(q.over + q.under + q.push, 1, 1e-9);
  // more spread => fatter tails
  assert.ok(M.lineProbs(30.5, 25, 60).over > M.lineProbs(30.5, 25, 26).over);
  // continuous (minutes)
  close(M.lineProbs(32, 32, 16, true).over, 0.5, 1e-9);
});

function fakeGames(n, fn) {
  return Array.from({ length: n }, (_, i) => {
    const d = new Date(Date.UTC(2026, 10, 30) - i * 2 * 864e5).toISOString().slice(0, 10);
    return Object.assign({ date: d, opp: 'BOS', home: 1, min: 30, pts: 15, reb: 5, ast: 4, fg3m: 2, stl: 1, blk: 0, tov: 2, fga: 12, gid: 'g' + i, season: 'current' }, fn ? fn(i) : {});
  });
}

test('projection recovers a steady player', () => {
  const pr = M.project(fakeGames(25), 'PTS');
  close(pr.mean, 15, 1e-9);
  close(pr.minutes, 30, 1e-9);
  assert.ok(pr.variance >= 15 * 1.05 - 1e-9); // Poisson floor
  const pra = M.project(fakeGames(25), 'PRA');
  close(pra.mean, 24, 1e-9);
});

test('projection reacts to a minutes increase and opponent factor', () => {
  // last 5 games at 36 min (same per-minute rate), before that 30
  const g = fakeGames(25, (i) => (i < 5 ? { min: 36, pts: 18 } : {}));
  const pr = M.project(g, 'PTS');
  assert.ok(pr.minutes > 33 && pr.minutes < 36, 'minutes should lean recent: ' + pr.minutes);
  close(pr.rate, 0.5, 1e-9);
  const soft = M.project(g, 'PTS', { oppFactor: 1.1 });
  close(soft.mean / pr.mean, 1.1, 1e-9);
});

test('without-teammate split', () => {
  // player scores 22 in 34 min when teammate is out (games 0-3), 15 in 30 min with him
  const player = fakeGames(24, (i) => (i < 4 ? { min: 34, pts: 22 } : {}));
  const mate = player.filter((_, i) => i >= 4).map((g) => ({ ...g })); // mate missed games 0-3
  const w = M.withoutSplit(player, mate, 'PTS');
  assert.equal(w.n, 4);
  close(w.minRatio, 34 / 30, 1e-9);
  close(w.rateRatio, (22 / 34) / 0.5, 1e-9);
  const pr = M.project(player, 'PTS', { mates: [{ name: 'Mate', games: mate }] });
  const base = M.project(player, 'PTS');
  assert.ok(pr.mean > base.mean, 'teammate out should raise projection');
  // shrinkage: 4 games of evidence -> only partly applied
  assert.ok(pr.factors.minutes < 34 / 30 && pr.factors.minutes > 1);
});

test('price() ties it together', () => {
  const r = M.price({ games: fakeGames(25), stat: 'PTS', line: 14.5, overOdds: 1.87, underOdds: 1.87 });
  assert.ok(r.probs.over > 0.5);
  close(r.over.ev, r.probs.over * 0.87 - (1 - r.probs.over), 1e-9);
  close(r.market.over, 0.5);
});

test('edge cases: zero-mean player and zero variance', () => {
  const zero = M.lineProbs(0.5, 0, 0);
  assert.equal(zero.over, 0); assert.equal(zero.under, 1);
  const g = fakeGames(20, () => ({ fg3m: 0 }));
  const pr = M.project(g, 'FG3M');
  const p = M.projProbs(0.5, pr);
  assert.ok(p && p.over === 0);
});
