#!/usr/bin/env node
// glide_reconcile — does the CONSTRUCTED target-date series reproduce the real
// funds it models?
//
// NO NETWORK, like everything else in this directory. Reads local JSON, does
// arithmetic, prints basis points.
//
// Two independent ground truths, because the construction has two halves that
// fail differently:
//
//   1. MONTHLY, against the real fund. benchmarks.json carries VTTSX — the
//      real Vanguard Target Retirement 2060 Fund — monthly from 2021-10. A
//      constructed 2060 series over the same months is checked month by month
//      and compounded per calendar year. This is the tightest check available
//      and the only one at monthly resolution, but the 2060 fund is about 90%
//      equity, so it says almost nothing about the part of the construction
//      most likely to be wrong.
//
//   2. ANNUAL, across the whole ladder. sources/issuer-target-date-annual.json
//      carries the issuer's published calendar-year returns for every fund
//      from Income to 2065. Constructed series for each of those target years
//      are compounded onto them. THIS is the check that matters, because it
//      sweeps the glide path from 90% equity down to 30% and therefore prices
//      the approximation the construction actually makes: benchmarks.json has
//      no short-term TIPS series and no hedged international bond series, so
//      both are modelled as US investment-grade bonds. If that approximation
//      is expensive, it shows up here as residuals that grow monotonically as
//      the target year approaches, and it does.
//
// Usage:
//   node glide_reconcile.mjs              full report
//   node glide_reconcile.mjs --json       machine-readable
//   node glide_reconcile.mjs --extra 8    add N bp/yr of drag and re-measure

import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const DATA = join(HERE, '..', 'core', 'src', 'data');

const benchmarks = JSON.parse(readFileSync(join(DATA, 'benchmarks.json'), 'utf8'));
const glide = JSON.parse(readFileSync(join(DATA, 'glide-path.json'), 'utf8'));
const issuer = JSON.parse(readFileSync(join(HERE, 'sources', 'issuer-target-date-annual.json'), 'utf8'));

const args = process.argv.slice(2);
const asJson = args.includes('--json');
const extraIdx = args.indexOf('--extra');
const extraBp = extraIdx >= 0 ? Number(args[extraIdx + 1]) : 0;

// ─────────────────────────────────────────── the construction, in miniature
// Deliberately a re-implementation rather than an import of core/src/glide.ts:
// this file is the check, and a check that shares its arithmetic with the
// thing it checks can only ever confirm that a function equals itself. The two
// agreeing is worth something; core's own test suite asserts they do.

const SERIES = { us: 'US_TOTAL', intl: 'INTL_TOTAL', bond: 'BOND_TOTAL' };

function decYear(monthKey) {
  const [y, m] = monthKey.split('-').map(Number);
  const end = Date.UTC(y, m, 0);
  return y + (end - Date.UTC(y, 0, 1)) / (Date.UTC(y + 1, 0, 1) - Date.UTC(y, 0, 1));
}

function scheduleFor(monthKey) {
  let picked = glide.schedules[0];
  for (const s of glide.schedules) if (s.asOf <= `${monthKey}-31`) picked = s;
  return picked;
}

function lerp(points, t, key) {
  if (t <= points[0].t) return points[0][key];
  if (t >= points[points.length - 1].t) return points[points.length - 1][key];
  for (let i = 1; i < points.length; i++) {
    const a = points[i - 1];
    const b = points[i];
    if (t <= b.t) return a[key] + ((t - a.t) / (b.t - a.t)) * (b[key] - a[key]);
  }
  return points[points.length - 1][key];
}

function weights(retireYear, monthKey) {
  const s = scheduleFor(monthKey);
  const t = retireYear - decYear(monthKey);
  const eq = lerp(s.points, t, 'equity') / 100;
  const us = lerp(s.points, t, 'usEquityShare') / 100;
  return { [SERIES.us]: eq * us, [SERIES.intl]: eq * (1 - us), [SERIES.bond]: 1 - eq };
}

/** Constructed monthly return, percent, rebalanced to that month's target. */
function monthReturn(retireYear, monthKey) {
  const w = weights(retireYear, monthKey);
  let r = 0;
  for (const [id, weight] of Object.entries(w)) {
    const v = benchmarks.monthly[id]?.[monthKey];
    if (v === undefined) throw new Error(`missing monthly ${id} ${monthKey}`);
    r += weight * (v / 100);
  }
  return ((1 + r) * Math.pow(1 - extraBp / 10000, 1 / 12) - 1) * 100;
}

// ───────────────────────────────────────────────────────────────── helpers

const stat = (a) => {
  const n = a.length;
  const mean = a.reduce((x, y) => x + y, 0) / n;
  const rms = Math.sqrt(a.reduce((x, y) => x + y * y, 0) / n);
  const worst = a.reduce((x, y) => (Math.abs(y) > Math.abs(x) ? y : x), 0);
  return { n, mean, rms, worst };
};
const f = (x, d = 1) => (x >= 0 ? '+' : '') + x.toFixed(d);
const line = (s) => { if (!asJson) console.log(s); };

// ───────────────────────────── check 1: monthly, against the real VTTSX

const real = benchmarks.monthly.TARGET_2060;
const realMonths = Object.keys(real).sort();
const monthlyResiduals = realMonths.map((mk) => (monthReturn(2060, mk) - real[mk]) * 100);
const monthlyStat = stat(monthlyResiduals);

const monthlyYears = {};
for (const mk of realMonths) (monthlyYears[mk.slice(0, 4)] ??= []).push(mk);
const monthlyByYear = Object.entries(monthlyYears).map(([y, ms]) => {
  const c = (pick) => ms.reduce((p, mk) => p * (1 + pick(mk) / 100), 1) - 1;
  const con = c((mk) => monthReturn(2060, mk));
  const act = c((mk) => real[mk]);
  return { year: y, months: ms.length, constructed: con * 100, real: act * 100, bp: (con - act) * 10000 };
});

line('');
line('CHECK 1 — constructed 2060 against the REAL Vanguard 2060 fund (VTTSX)');
line(`  window ${realMonths[0]} .. ${realMonths[realMonths.length - 1]}, monthly`);
line('');
line(`  per month   n=${monthlyStat.n}  mean ${f(monthlyStat.mean, 2)}bp  ` +
     `rms ${monthlyStat.rms.toFixed(2)}bp  worst ${f(monthlyStat.worst, 1)}bp`);
line('');
line('  year   mths   constructed        real      diff');
for (const r of monthlyByYear) {
  line(`  ${r.year}    ${String(r.months).padStart(2)}   ${r.constructed.toFixed(2).padStart(9)}%  ` +
       `${r.real.toFixed(2).padStart(9)}%  ${f(r.bp, 1).padStart(8)}bp`);
}
line('');
line('  A mean near zero is the thing to look at. A construction that had lost');
line('  the dividends would sit 150-400bp low every single year, one-directionally.');

// ─────────────── check 2: annual, across the ladder, against the issuer

const ladder = [];
for (const [fund, rec] of Object.entries(issuer)) {
  if (fund.startsWith('_') || fund === 'INCOME') continue;
  const retireYear = Number(fund);
  const rows = [];
  for (const [year, published] of Object.entries(rec.annual)) {
    const ms = Object.keys(benchmarks.monthly[SERIES.intl])
      .filter((m) => m.startsWith(year))
      .sort();
    if (ms.length !== 12) continue;
    let g = 1;
    for (const mk of ms) g *= 1 + monthReturn(retireYear, mk) / 100;
    const constructed = (g - 1) * 100;
    rows.push({ year, constructed, published, bp: (constructed - published) * 100 });
  }
  if (!rows.length) continue;
  // how much of this fund is NOT equity, on the modelled path, mid-window
  const w = weights(retireYear, `${rows[Math.floor(rows.length / 2)].year}-06`);
  ladder.push({ fund, bondShare: w[SERIES.bond] * 100, rows, ...stat(rows.map((r) => r.bp)) });
}
ladder.sort((a, b) => a.bondShare - b.bondShare);

line('');
line('CHECK 2 — constructed series against the ISSUER\'S published calendar-year');
line('          returns, for the whole fund ladder');
line('');
line('  fund   modelled     n   mean rms  worst   the approximation being priced');
line('         bond share            (basis points a year)');
for (const r of ladder) {
  line(`  ${r.fund}    ${r.bondShare.toFixed(0).padStart(4)}%    ${String(r.n).padStart(3)}  ` +
       `${f(r.mean, 1).padStart(6)} ${r.rms.toFixed(1).padStart(4)} ${f(r.worst, 1).padStart(6)}`);
}
const all = stat(ladder.flatMap((r) => r.rows.map((x) => x.bp)));
line('');
line(`  all      n=${all.n}  mean ${f(all.mean, 1)}bp  rms ${all.rms.toFixed(1)}bp  worst ${f(all.worst, 1)}bp`);
line('');
line('  The residual tracks the bond share, monotonically, and that is the whole');
line('  finding: benchmarks.json has no short-term TIPS series and no hedged');
line('  international bond series, so this models both as US investment-grade');
line('  bonds. On a long-dated fund that is nearly all equity it costs single');
line('  digits of basis points a year. On a fund at or past its target year it');
line('  costs tens. Anyone shown a near-dated constructed reference should be');
line('  told that, which is what the strategy\'s `caution` does.');

// ────────────────────────────────────────────────────────────── per-year

const byYear = {};
for (const r of ladder) for (const x of r.rows) (byYear[x.year] ??= []).push(x.bp);
line('');
line('  by calendar year — a bad year in the underlying data would show here,');
line('  across every fund at once, rather than in one fund across every year:');
for (const [year, bps] of Object.entries(byYear).sort()) {
  const s = stat(bps);
  line(`    ${year}  n=${s.n}  mean ${f(s.mean, 1).padStart(6)}bp  rms ${s.rms.toFixed(1).padStart(5)}bp  worst ${f(s.worst, 1).padStart(6)}bp`);
}
if (extraBp) line(`\n  (measured with ${extraBp}bp/yr of extra drag applied)`);
line('');

if (asJson) {
  console.log(JSON.stringify({
    extraBp,
    monthlyVsRealFund: { window: [realMonths[0], realMonths[realMonths.length - 1]], ...monthlyStat, byYear: monthlyByYear },
    annualVsIssuer: { overall: all, byFund: ladder, byYear: Object.fromEntries(Object.entries(byYear).map(([y, b]) => [y, stat(b)])) },
  }, null, 1));
}
