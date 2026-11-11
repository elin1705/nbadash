/*
 * NBA Props Dash — projection & pricing model.
 * One file used by the dashboard (browser) and by the tests/backtest (Node),
 * so the numbers you see on the site are exactly the ones that were tested.
 *
 * Game objects (newest first): {date, opp, home, min, pts, reb, ast, fg3m, stl, blk, tov, fga, gid, season}
 */
(function (root) {
  'use strict';

  // ------------------------------------------------------------ stat definitions
  const STATS = {
    PTS:  { label: 'Points',       parts: ['pts'] },
    REB:  { label: 'Rebounds',     parts: ['reb'] },
    AST:  { label: 'Assists',      parts: ['ast'] },
    FG3M: { label: '3PM',          parts: ['fg3m'] },
    PRA:  { label: 'Pts+Reb+Ast',  parts: ['pts', 'reb', 'ast'] },
    PR:   { label: 'Pts+Reb',      parts: ['pts', 'reb'] },
    PA:   { label: 'Pts+Ast',      parts: ['pts', 'ast'] },
    RA:   { label: 'Reb+Ast',      parts: ['reb', 'ast'] },
    STL:  { label: 'Steals',       parts: ['stl'] },
    BLK:  { label: 'Blocks',       parts: ['blk'] },
    SB:   { label: 'Stl+Blk',      parts: ['stl', 'blk'] },
    TOV:  { label: 'Turnovers',    parts: ['tov'] },
    FGA:  { label: 'FG attempts',  parts: ['fga'] },
    MIN:  { label: 'Minutes',      parts: ['min'], continuous: true },
  };
  // game-log key -> defence-vs-position key
  const DVP_KEY = { pts: 'PTS', reb: 'REB', ast: 'AST', fg3m: 'FG3M', stl: 'STL', blk: 'BLK', tov: 'TOV', fga: 'FGA' };

  function statValue(stat, g) {
    let v = 0;
    for (const p of STATS[stat].parts) v += g[p] || 0;
    return v;
  }

  // ------------------------------------------------------------ odds maths
  const impliedProb = (odds) => (odds > 1 ? 1 / odds : null);

  /** Remove the bookmaker margin from a two-way market (decimal odds). */
  function devig(overOdds, underOdds) {
    const po = impliedProb(overOdds), pu = impliedProb(underOdds);
    if (po == null) return null;
    if (pu == null) return { over: po, under: 1 - po, margin: null, twoWay: false };
    const book = po + pu;
    return { over: po / book, under: pu / book, margin: book - 1, twoWay: true };
  }

  /** Expected value per $1 staked. pWin/pPush from the model. */
  function expectedValue(pWin, odds, pPush = 0) {
    // push refunds the stake
    return pWin * (odds - 1) - (1 - pWin - pPush);
  }

  /** Kelly fraction of bankroll (can be negative = don't bet). */
  function kelly(pWin, odds, pPush = 0) {
    const b = odds - 1;
    const pLose = 1 - pWin - pPush;
    return (b * pWin - pLose) / b;
  }

  const fairOdds = (p) => (p > 0 ? 1 / p : null);

  // ------------------------------------------------------------ distributions
  function erf(x) { // Abramowitz & Stegun 7.1.26, |error| < 1.5e-7
    const s = Math.sign(x); x = Math.abs(x);
    const t = 1 / (1 + 0.3275911 * x);
    const y = 1 - (((((1.061405429 * t - 1.453152027) * t) + 1.421413741) * t - 0.284496736) * t + 0.254829592) * t * Math.exp(-x * x);
    return s * y;
  }
  const normCdf = (x, mu = 0, sd = 1) => 0.5 * (1 + erf((x - mu) / (sd * Math.SQRT2)));

  function lgamma(z) { // Lanczos approximation
    const g = 7;
    const c = [0.99999999999980993, 676.5203681218851, -1259.1392167224028, 771.32342877765313,
      -176.61502916214059, 12.507343278686905, -0.13857109526572012, 9.9843695780195716e-6, 1.5056327351493116e-7];
    if (z < 0.5) return Math.log(Math.PI / Math.sin(Math.PI * z)) - lgamma(1 - z);
    z -= 1;
    let x = c[0];
    for (let i = 1; i < g + 2; i++) x += c[i] / (z + i);
    const t = z + g + 0.5;
    return 0.5 * Math.log(2 * Math.PI) + (z + 0.5) * Math.log(t) - t + Math.log(x);
  }

  /** P(X = k) for a count stat with given mean & variance (negative binomial, or Poisson if not over-dispersed). */
  function countPmf(k, mean, variance) {
    if (mean <= 0) return k === 0 ? 1 : 0;
    if (variance <= mean * 1.0001) {
      return Math.exp(-mean + k * Math.log(mean) - lgamma(k + 1));
    }
    const r = (mean * mean) / (variance - mean);
    const p = r / (r + mean);
    return Math.exp(lgamma(k + r) - lgamma(r) - lgamma(k + 1) + r * Math.log(p) + k * Math.log(1 - p));
  }

  /** Probabilities of over / push / under a line. */
  function lineProbs(line, mean, variance, continuous = false) {
    if (mean == null || isNaN(mean)) return null;
    if (!continuous && mean <= 0) return { over: 0, push: line === 0 ? 1 : 0, under: line === 0 ? 0 : 1 };
    if (!(variance > 0)) variance = Math.max(mean, 1e-6);
    if (continuous) {
      const under = normCdf(line, mean, Math.sqrt(variance));
      return { over: 1 - under, push: 0, under };
    }
    // count stat: P(X <= floor(line)) etc.
    const k = Math.floor(line);
    const isInt = Math.abs(line - k) < 1e-9;
    let cdfBelow = 0; // P(X < k) if integer line, else P(X <= k)
    const upto = isInt ? k - 1 : k;
    for (let i = 0; i <= upto; i++) cdfBelow += countPmf(i, mean, variance);
    const push = isInt ? countPmf(k, mean, variance) : 0;
    cdfBelow = Math.min(1, cdfBelow);
    return { over: Math.max(0, 1 - cdfBelow - push), push, under: cdfBelow };
  }

  /** Line probabilities for a projection, including the dud-game mixture. */
  function projProbs(line, pr, continuous = false) {
    const main = lineProbs(line, pr.mean, pr.variance, continuous);
    if (!pr.dudRate) return main;
    const dm = pr.mean * pr.dudScale;
    const dud = lineProbs(line, dm, Math.max(pr.variance * pr.dudScale, dm * 1.05 + 1e-9), continuous);
    const q = pr.dudRate;
    return { over: (1 - q) * main.over + q * dud.over, push: (1 - q) * main.push + q * dud.push, under: (1 - q) * main.under + q * dud.under };
  }

  // ------------------------------------------------------------ projection
  const DEFAULTS = {
    rateHalfLife: 10,   // games: how fast older per-minute production fades
    minHalfLife: 4,     // games: minutes react faster to role changes
    lastSeasonWeight: 0.6,
    maxGames: 40,
    minMinutes: 6,      // ignore near-DNP cameo games
    oppShrink: 15,      // DvP sample shrink (games)
    withoutShrink: 12,  // teammate-out sample shrink (games)
    varInflate: 1.15,   // extra spread on top of the player's own game-to-game spread
    dudRate: 0.05,      // chance of a 'dud' game (injury exit, foul trouble, blowout benching)
    dudScale: 0.35,     // a dud game produces this share of normal output
  };

  function weightedMean(xs, ws) {
    let s = 0, w = 0;
    for (let i = 0; i < xs.length; i++) { s += xs[i] * ws[i]; w += ws[i]; }
    return w ? s / w : null;
  }

  /**
   * Project a player's stat for the next game.
   * opts.oppFactor   multiplier from opponent defence (see opponentFactor)
   * opts.mates       [{name, games}] teammates ruled out — adjusts minutes & rate from "without" splits
   * Returns {mean, variance, minutes, rate, factors, sample} or null.
   */
  function project(games, stat, opts = {}) {
    const o = Object.assign({}, DEFAULTS, opts);
    const def = STATS[stat];
    const usable = games.filter((g) => g.min >= o.minMinutes).slice(0, o.maxGames);
    if (usable.length < 3) return null;

    const seasonW = (g) => (g.season === 'previous' ? o.lastSeasonWeight : 1);
    const wRate = usable.map((g, i) => Math.pow(0.5, i / o.rateHalfLife) * seasonW(g));
    const mGames = usable.slice(0, 10);
    const wMin = mGames.map((g, i) => Math.pow(0.5, i / o.minHalfLife) * seasonW(g));

    const mins = usable.map((g) => g.min);
    const vals = usable.map((g) => statValue(stat, g));
    const totMinW = weightedMean(mins, wRate);
    const minutes = weightedMean(mGames.map((g) => g.min), wMin);
    const minVar = weightedMean(mGames.map((g) => (g.min - minutes) ** 2), wMin);

    // ---- teammate-out adjustment
    let minFactor = 1, rateFactor = 1;
    const mateNotes = [];
    for (const m of o.mates || []) {
      const w = withoutSplit(games.filter((g) => g.min >= o.minMinutes), m.games, stat);
      if (!w) { mateNotes.push({ name: m.name, n: 0 }); continue; }
      const k = w.n / (w.n + o.withoutShrink);
      const mf = 1 + (w.minRatio - 1) * k;
      const rf = 1 + (w.rateRatio - 1) * k;
      minFactor *= mf; rateFactor *= rf;
      mateNotes.push({ name: m.name, n: w.n, minRatio: w.minRatio, rateRatio: w.rateRatio, minFactor: mf, rateFactor: rf });
    }
    minFactor = Math.min(1.3, Math.max(0.8, minFactor));
    rateFactor = Math.min(1.35, Math.max(0.8, rateFactor));

    const oppFactor = def.continuous ? 1 : (o.oppFactor || 1);
    const projMin = minutes * minFactor;

    let mean, variance, rate;
    if (def.continuous) {
      rate = 1;
      mean = projMin;
      variance = Math.max(minVar, 4);
    } else {
      rate = weightedMean(vals, wRate) / totMinW; // stat per minute
      mean = projMin * rate * rateFactor * oppFactor;
      // variance: spread around minute-adjusted expectation + minutes uncertainty
      const resid = usable.map((g, i) => (vals[i] - rate * g.min) ** 2);
      const condVar = weightedMean(resid, wRate) * (projMin / totMinW);
      variance = (condVar + rate * rate * minVar) * rateFactor * oppFactor;
      variance = Math.max(variance * o.varInflate, mean * 1.05); // never tighter than Poisson
    }
    return {
      mean, variance, sd: Math.sqrt(variance), minutes: projMin, baseMinutes: minutes, rate,
      factors: { opp: oppFactor, minutes: minFactor, rate: rateFactor },
      dudRate: o.dudRate, dudScale: o.dudScale,
      mates: mateNotes, sample: usable.length,
      sampleCurrent: usable.filter((g) => g.season !== 'previous').length,
    };
  }

  /** Compare a player's games with vs without a teammate (only games after they first shared a court). */
  function withoutSplit(playerGames, mateGames, stat) {
    if (!mateGames || !mateGames.length) return null;
    const mateIds = new Set(mateGames.map((g) => g.gid));
    const shared = playerGames.filter((g) => mateIds.has(g.gid));
    if (!shared.length) return null;
    const firstShared = shared.reduce((a, g) => (g.date < a ? g.date : a), shared[0].date);
    const window = playerGames.filter((g) => g.date >= firstShared);
    const without = window.filter((g) => !mateIds.has(g.gid));
    const withG = window.filter((g) => mateIds.has(g.gid));
    if (without.length < 1 || withG.length < 3) return null;
    const agg = (arr) => {
      let m = 0, v = 0;
      for (const g of arr) { m += g.min; v += statValue(stat, g); }
      return { min: m / arr.length, rate: m ? v / m : 0, avg: v / arr.length };
    };
    const a = agg(without), b = agg(withG);
    return {
      n: without.length, nWith: withG.length,
      minRatio: b.min ? a.min / b.min : 1,
      rateRatio: b.rate ? a.rate / b.rate : 1,
      without: a, with: b, games: without,
    };
  }

  /** Opponent multiplier from defence-vs-position, shrunk toward 1 for small samples. */
  function opponentFactor(stat, grp, oppTeam, allTeams, playerRates, shrink = DEFAULTS.oppShrink) {
    const span = 'season';
    const d = oppTeam && oppTeam.dvp && oppTeam.dvp[span] && oppTeam.dvp[span][grp];
    if (!d || !grp) return { factor: 1, parts: [] };
    const gp = oppTeam.dvp[span].gp || 0;
    const k = gp / (gp + shrink);
    const parts = [];
    let num = 0, den = 0;
    for (const p of STATS[stat].parts) {
      const key = DVP_KEY[p];
      if (!key) continue;
      const vals = allTeams.map((t) => t.dvp && t.dvp[span] && t.dvp[span][grp] && t.dvp[span][grp][key]).filter((v) => v != null);
      const lg = vals.reduce((a, b) => a + b, 0) / (vals.length || 1);
      if (!lg || d[key] == null) continue;
      const f = 1 + (d[key] / lg - 1) * k;
      const w = (playerRates && playerRates[p]) || 1;
      num += f * w; den += w;
      parts.push({ part: p, allowed: d[key], league: lg, raw: d[key] / lg, factor: f });
    }
    return { factor: den ? num / den : 1, parts, gp };
  }

  /** Full pricing of one prop. */
  function price({ games, stat, line, overOdds, underOdds, oppFactor = 1, mates = [] }) {
    const proj = project(games, stat, { oppFactor, mates });
    if (!proj) return null;
    const probs = projProbs(line, proj, !!STATS[stat].continuous);
    const market = devig(overOdds, underOdds);
    const out = { proj, probs, market };
    if (overOdds > 1) {
      out.over = { ev: expectedValue(probs.over, overOdds, probs.push), kelly: kelly(probs.over, overOdds, probs.push),
        edge: market ? probs.over - market.over : null };
    }
    if (underOdds > 1) {
      out.under = { ev: expectedValue(probs.under, underOdds, probs.push), kelly: kelly(probs.under, underOdds, probs.push),
        edge: market && market.twoWay ? probs.under - market.under : null };
    }
    out.fairOver = fairOdds(probs.over);
    out.fairUnder = fairOdds(probs.under);
    return out;
  }

  // ------------------------------------------------------------ backtest
  /**
   * Walk-forward test: for each past game, project using ONLY earlier games and compare
   * predicted P(over) with what actually happened. No opponent/teammate adjustments (base model).
   * playerGames: {pid: gamesNewestFirst}
   */
  function backtest(playerGames, opts = {}) {
    const stats = opts.stats || ['PTS', 'REB', 'AST', 'FG3M', 'PRA'];
    const minPrior = opts.minPrior || 10;
    const recs = []; // [p, hit, kind]
    for (const pid of Object.keys(playerGames)) {
      const g = playerGames[pid];
      if (g.length < minPrior + 1) continue;
      for (let i = g.length - minPrior - 1; i >= 0; i--) {
        const game = g[i];
        if (opts.outcomeSeason && game.season !== opts.outcomeSeason) continue;
        const prior = g.slice(i + 1);
        if (prior[0].min < 20 && prior.length < 15) continue;
        for (const stat of stats) {
          const pr = project(prior, stat, opts.model || {});
          if (!pr || pr.mean < 0.5) continue;
          const actual = statValue(stat, game);
          // a "main" line near the projection, plus a low alt line (filler-leg territory)
          const lines = [
            ['main', Math.round(pr.mean - 0.5) + 0.5],
            ['alt', Math.max(0.5, Math.floor(pr.mean * 0.55) - 0.5)],
          ];
          for (const [kind, line] of lines) {
            const p = projProbs(line, pr).over;
            // naive baseline: last-10 hit rate
            const last10 = prior.slice(0, 10);
            const base = last10.filter((x) => statValue(stat, x) > line).length / last10.length;
            recs.push([p, actual > line ? 1 : 0, kind, base, stat]);
          }
        }
      }
    }
    const summarise = (rs) => {
      const buckets = Array.from({ length: 10 }, (_, b) => ({ lo: b / 10, hi: (b + 1) / 10, n: 0, pSum: 0, hits: 0 }));
      let brier = 0, brierBase = 0;
      for (const [p, y, , base] of rs) {
        const b = buckets[Math.min(9, Math.floor(p * 10))];
        b.n++; b.pSum += p; b.hits += y;
        brier += (p - y) ** 2; brierBase += (base - y) ** 2;
      }
      return {
        n: rs.length,
        brier: rs.length ? brier / rs.length : null,
        brierBaseline: rs.length ? brierBase / rs.length : null,
        buckets: buckets.map((b) => ({ lo: b.lo, hi: b.hi, n: b.n, predicted: b.n ? b.pSum / b.n : null, actual: b.n ? b.hits / b.n : null })),
      };
    };
    const high = recs.filter((r) => r[0] >= 0.95);
    return {
      all: summarise(recs),
      main: summarise(recs.filter((r) => r[2] === 'main')),
      alt: summarise(recs.filter((r) => r[2] === 'alt')),
      safe: { n: high.length, predicted: high.length ? high.reduce((a, r) => a + r[0], 0) / high.length : null,
        actual: high.length ? high.reduce((a, r) => a + r[1], 0) / high.length : null },
      byStat: Object.fromEntries(stats.map((s) => [s, summarise(recs.filter((r) => r[4] === s && r[2] === 'main'))])),
    };
  }

  const Model = {
    STATS, DVP_KEY, DEFAULTS, statValue, impliedProb, devig, expectedValue, kelly, fairOdds,
    normCdf, lgamma, countPmf, lineProbs, projProbs, project, withoutSplit, opponentFactor, price, backtest,
  };
  if (typeof module !== 'undefined' && module.exports) module.exports = Model;
  else root.Model = Model;
})(typeof globalThis !== 'undefined' ? globalThis : this);
