import { strict as assert } from 'node:assert';
import { test, describe } from 'node:test';
import { readFileSync, writeFileSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { compound, findDuplicateKeys, loadCandidate, parseYtdMarker } from '../src/load.mjs';
import { DEFAULT_THRESHOLDS, STATUS, detectPriceOnly, noiseFloor, reconcileSeries, signTestP } from '../src/reconcile.mjs';
import { checkStructure, checkStrategyReferences } from '../src/structure.mjs';
import { checkComposite, checkComposites, fitWeight, rollingWeights, COMPOSITES, COMPOSITE_THRESHOLDS } from '../src/composite.mjs';
import { diffSeries } from '../src/diff.mjs';
import { runCheck } from '../verify.mjs';
import {
  addNoise, clone, dropMonth, jsonWithDuplicateKey, makePriceOnly,
  perturbMonth, setMonth, shuffleKeys,
} from '../src/degrade.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const BENCHMARKS = join(HERE, '..', '..', 'core', 'src', 'data', 'benchmarks.json');
const STRATEGIES = join(HERE, '..', '..', 'core', 'src', 'data', 'strategies.json');

const good = () => loadCandidate(BENCHMARKS);
const ytdOf = (c) => parseYtdMarker(c.meta);

function reconcile(candidate, seriesId, opts = {}) {
  return reconcileSeries(seriesId, candidate.monthly[seriesId], candidate.annual[seriesId], {
    ytd: ytdOf(candidate), ...opts,
  });
}

// ---------------------------------------------------------------- basics ----

describe('arithmetic', () => {
  test('compound multiplies, it does not add', () => {
    assert.equal(Number(compound([10, 10]).toFixed(6)), 21);
    assert.equal(Number(compound([50, -50]).toFixed(6)), -25);
    assert.equal(compound([]), 0);
  });

  test('sign test recognises a one-sided run', () => {
    assert.ok(signTestP(5, 5) < 0.07);
    assert.ok(signTestP(30, 30) < 1e-8);
    assert.ok(signTestP(3, 5) > 0.5);
  });

  test('YTD marker is read out of the coverage string', () => {
    assert.deepEqual(parseYtdMarker({ coverage: { annual: '1996-2026 (2026 = YTD through 31 Jul)' } }),
      { year: 2026, throughMonth: 7 });
    assert.equal(parseYtdMarker({ coverage: { annual: '1996-2025' } }), null);
  });
});

// -------------------------------------------------- the shipped data is ok ----

describe('shipped benchmarks.json', () => {
  test('passes the full check', () => {
    const res = runCheck(good(), { strategies: JSON.parse(readFileSync(STRATEGIES, 'utf8')) });
    assert.notEqual(res.verdict, STATUS.FAIL, JSON.stringify(res.findings, null, 2));
    assert.deepEqual(res.priceOnlySeries, []);
  });

  test('every core series reconciles inside the empirical floor', () => {
    const c = good();
    // Comparable-year counts, which double as a coverage tripwire: the v1.1.0
    // backfill took three series to 1996-01 and INTL_TOTAL only to 2004-01,
    // for the reason `meta.notes` gives under "WHY INTL_TOTAL STOPS AT 2004".
    // These were all 5 when the monthly data began in 2021-10.
    const expected = { US_500: 31, US_TOTAL: 31, INTL_TOTAL: 23, BOND_TOTAL: 31 };
    for (const [id, n] of Object.entries(expected)) {
      const r = reconcile(c, id);
      assert.equal(r.status, STATUS.OK, `${id} is ${r.status}`);
      assert.equal(r.stats.n, n, `${id} should have ${n} comparable years`);
      assert.ok(r.stats.maxAbs < DEFAULT_THRESHOLDS.warnBp, `${id} max ${r.stats.maxAbs}bp`);
    }
  });

  test('a partial leading year is skipped, not failed', () => {
    // No shipped series has one any more — the backfill starts every series
    // on a January, so 2021 is a complete year for all four and the code path
    // has nothing real to run on. It is still the path that stops a
    // three-month stub being scored against a twelve-month annual figure, so
    // it is exercised here on a candidate truncated to start mid-year.
    const c = clone(good());
    for (const k of Object.keys(c.monthly.US_500)) {
      if (k < '1996-10') delete c.monthly.US_500[k];
    }
    const r = reconcile(c, 'US_500');
    const y1996 = r.rows.find((x) => x.year === 1996);
    assert.equal(y1996.status, STATUS.SKIP);
    assert.match(y1996.note, /window starts 1996-10/);
    assert.equal(y1996.diffBp, null);
    // and the years behind it are unaffected
    assert.equal(r.rows.find((x) => x.year === 1997).status, STATUS.OK);
  });

  test('the YTD year IS compared, against the seven months it covers', () => {
    const r = reconcile(good(), 'US_TOTAL');
    const y2026 = r.rows.find((x) => x.year === 2026);
    assert.equal(y2026.monthCount, 7);
    assert.notEqual(y2026.diffBp, null);
    assert.equal(y2026.status, STATUS.OK);
  });

  test('the pooled noise floor is small, and now has two populations in it', () => {
    const nf = noiseFloor(good());
    assert.equal(nf.n, 116, 'four series over 1996-2026, INTL_TOTAL from 2004');
    assert.ok(nf.maxAbs < 50, `max |${nf.maxAbs}|bp`);
    assert.ok(nf.mean > 0 && nf.mean < 25, `mean ${nf.mean}bp`);

    // The pooled mean fell from +12bp to +2bp with the backfill, and that is
    // a fact about BASIS, not about accuracy. NOISE-FLOOR.md term (2): the
    // 2021-10-onward monthly series are ETFs measured against mutual-fund
    // annual figures, so they compound slightly high; the backfill uses the
    // same mutual-fund share classes as the annual series, so that term is
    // absent from it and its residuals sit on zero. Pooling the two and
    // taking |mean| + 4sd — which is what `noise-floor` suggests — averages
    // across two populations. Asserted so that nobody reads the smaller
    // pooled mean as the tolerance having earned a tightening.
    const c = good();
    const era = (from, to) => {
      const out = [];
      for (const id of ['US_500', 'US_TOTAL', 'INTL_TOTAL', 'BOND_TOTAL']) {
        for (const row of reconcile(c, id).rows) {
          if (row.diffBp != null && row.year >= from && row.year <= to) out.push(row.diffBp);
        }
      }
      return out;
    };
    const mean = (xs) => xs.reduce((a, b) => a + b, 0) / xs.length;
    const backfill = era(1996, 2020);
    const etf = era(2022, 2026);
    assert.ok(Math.abs(mean(backfill)) < 3, `backfill era mean ${mean(backfill).toFixed(1)}bp`);
    assert.ok(mean(etf) > 8, `ETF era mean ${mean(etf).toFixed(1)}bp`);
  });

  test('strategies.json only references series that exist', () => {
    const f = checkStrategyReferences(good(), JSON.parse(readFileSync(STRATEGIES, 'utf8')));
    assert.deepEqual(f.filter((x) => x.severity === 'ERROR'), []);
  });

  test('CASH is flagged as unverifiable — nothing can check it', () => {
    const f = checkStrategyReferences(good(), JSON.parse(readFileSync(STRATEGIES, 'utf8')));
    const orphan = f.find((x) => x.code === 'UNVERIFIABLE_SERIES');
    assert.ok(orphan, 'CASH has no annual series, no composite and no strategy');
    assert.equal(orphan.where, 'monthly.CASH');
  });
});

// -------------------------------------------------------- 1. PRICE-ONLY ----

describe('price-only detection', () => {
  for (const yieldPct of [1.5, 2.0, 3.0, 4.0]) {
    test(`catches a series degraded to price-only at ${yieldPct}pp/yr`, () => {
      const c = clone(good());
      c.monthly.US_500 = makePriceOnly(c.monthly.US_500, yieldPct);
      const r = reconcile(c, 'US_500');
      assert.equal(r.priceOnly.verdict, 'PRICE_ONLY', r.priceOnly.reason);
      assert.equal(r.status, STATUS.FAIL);
      assert.ok(r.priceOnly.inCanonicalBand);
      // The implied yield comes back slightly under the injected one, because
      // the shipped monthly series already sits ~0.15pp/yr ABOVE its annual
      // counterpart (ETF vs mutual-fund share class). What the checker measures
      // is the net, which is the honest number.
      assert.ok(
        Math.abs(r.priceOnly.impliedYieldPctPerYear - yieldPct) < 0.3,
        `implied ${r.priceOnly.impliedYieldPctPerYear} vs actual ${yieldPct}`,
      );
      // every full year should be short, in the same direction
      assert.equal(r.stats.negatives, r.stats.n);
    });
  }

  test('a whole file degraded to price-only is a NO-GO with named series', () => {
    const c = clone(good());
    for (const id of ['US_500', 'US_TOTAL', 'INTL_TOTAL']) {
      c.monthly[id] = makePriceOnly(c.monthly[id], 2.2);
    }
    const res = runCheck(c);
    assert.equal(res.verdict, STATUS.FAIL);
    assert.deepEqual(res.priceOnlySeries.sort(), ['INTL_TOTAL', 'US_500', 'US_TOTAL']);
  });

  test('symmetric noise of the same YEARLY magnitude is NOT called price-only', () => {
    // ~+/-25bp per month of random noise: individual years move a lot more
    // than the price-only case, but with no consistent sign.
    const c = clone(good());
    c.monthly.US_500 = addNoise(c.monthly.US_500, 25, 7);
    const r = reconcile(c, 'US_500');
    assert.notEqual(r.priceOnly.verdict, 'PRICE_ONLY');
  });

  test('the shipped data\'s own positive bias is reported as basis, not as price-only', () => {
    const r = reconcile(good(), 'US_500');
    assert.notEqual(r.priceOnly.verdict, 'PRICE_ONLY');
    assert.equal(r.priceOnly.verdict, 'NONE');
    assert.ok(r.stats.median > 0);
  });

  test('a single bad year cannot masquerade as price-only', () => {
    const stats = { n: 5, median: 5, negatives: 1, negFraction: 0.2, signTestP: 0.4 };
    assert.equal(detectPriceOnly(stats).verdict, 'NONE');
  });

  test('too few years is an admission of ignorance, not a pass', () => {
    const stats = { n: 2, median: -300, negatives: 2, negFraction: 1, signTestP: 0.5 };
    const d = detectPriceOnly(stats);
    assert.equal(d.verdict, 'NONE');
    assert.match(d.reason, /too few comparable years/);
  });

  test('a consistent shortfall too big for a dividend yield is flagged as SUSPECT', () => {
    const stats = { n: 5, median: -900, negatives: 5, negFraction: 1, signTestP: 0.06 };
    assert.equal(detectPriceOnly(stats).verdict, 'SUSPECT');
  });
});

// -------------------------------------------------------- 2. STRUCTURAL ----

describe('structural integrity', () => {
  test('a dropped interior month is caught as a gap and fails the series', () => {
    const c = clone(good());
    c.monthly.US_500 = dropMonth(c.monthly.US_500, '2023-06');
    const { findings } = checkStructure(c);
    const gap = findings.find((f) => f.code === 'GAP' && f.where === 'monthly.US_500');
    assert.ok(gap, 'expected a GAP finding');
    assert.match(gap.message, /2023-05.*2023-07/);

    const r = reconcile(c, 'US_500');
    const y = r.rows.find((x) => x.year === 2023);
    assert.equal(y.status, STATUS.SKIP);
    assert.match(y.note, /MISSING \(6\)/);
    assert.equal(r.status, STATUS.FAIL, 'an interior gap must fail, not silently skip');
    assert.equal(runCheck(c).verdict, STATUS.FAIL);
  });

  test('a duplicated month in the raw JSON is caught even though JSON.parse hides it', () => {
    const c = good();
    const text = jsonWithDuplicateKey(c, 'US_500', '2023-04');
    // JSON.parse itself notices nothing:
    assert.equal(Object.keys(JSON.parse(text).monthly.US_500).length,
      Object.keys(c.monthly.US_500).length);
    const dups = findDuplicateKeys(text);
    assert.equal(dups.length, 1);
    assert.equal(dups[0].key, '2023-04');
    assert.equal(dups[0].path, '$.monthly.US_500');

    const dir = mkdtempSync(join(tmpdir(), 'bench-'));
    const p = join(dir, 'dup.json');
    writeFileSync(p, text);
    const res = runCheck(loadCandidate(p));
    assert.equal(res.verdict, STATUS.FAIL);
    assert.ok(res.findings.some((f) => f.code === 'DUPLICATE_KEY'));
  });

  test('a badly perturbed month fails the year it lands in', () => {
    const c = clone(good());
    c.monthly.US_500 = perturbMonth(c.monthly.US_500, '2024-03', 5);
    const r = reconcile(c, 'US_500');
    const y = r.rows.find((x) => x.year === 2024);
    assert.equal(y.status, STATUS.FAIL);
    assert.ok(y.diffBp > 500, `diff ${y.diffBp}bp`);
    // and only that year
    assert.deepEqual(r.rows.filter((x) => x.status === STATUS.FAIL).map((x) => x.year), [2024]);
    assert.equal(runCheck(c).verdict, STATUS.FAIL);
  });

  test('a subtly perturbed month lands in WARN, above the noise floor', () => {
    const c = clone(good());
    c.monthly.US_500 = perturbMonth(c.monthly.US_500, '2024-03', 0.85);
    const r = reconcile(c, 'US_500');
    const y = r.rows.find((x) => x.year === 2024);
    assert.equal(y.status, STATUS.WARN);
  });

  test('an out-of-range value is caught', () => {
    const c = clone(good());
    c.monthly.US_500 = setMonth(c.monthly.US_500, '2024-03', 312.4); // decimal slip
    const f = checkStructure(c).findings;
    assert.ok(f.some((x) => x.code === 'OUT_OF_RANGE' && x.where === 'monthly.US_500'));
  });

  test('series-specific bounds catch a cash series that goes negative', () => {
    const c = clone(good());
    c.monthly.CASH = setMonth(c.monthly.CASH, '2024-03', -2.5);
    const f = checkStructure(c).findings;
    const hit = f.find((x) => x.code === 'OUT_OF_RANGE' && x.where === 'monthly.CASH');
    assert.ok(hit, 'a -2.5% month in a cash series is not plausible');
  });

  test('non-chronological keys are caught', () => {
    const c = clone(good());
    c.monthly.US_500 = shuffleKeys(c.monthly.US_500, '2023-04', '2024-09');
    const f = checkStructure(c).findings;
    assert.ok(f.some((x) => x.code === 'NOT_CHRONOLOGICAL'));
  });

  test('an undocumented null is an ERROR; the documented one is INFO', () => {
    const c = clone(good());
    const documented = checkStructure(c).findings
      .filter((f) => f.code === 'NULL_VALUE');
    assert.ok(documented.length > 0);
    assert.ok(documented.every((f) => f.severity === 'INFO'), 'shipped nulls are documented');

    c.monthly.US_500 = setMonth(c.monthly.US_500, '2024-03', null);
    const f = checkStructure(c).findings
      .filter((x) => x.code === 'NULL_VALUE' && x.where === 'monthly.US_500');
    assert.equal(f.length, 1);
    assert.equal(f[0].severity, 'ERROR');
    assert.match(f[0].message, /meta\.notes/);
  });

  test('a coverage claim that does not match the data is caught', () => {
    const c = clone(good());
    c.meta.coverage.monthly = '2015-01 through 2026-07';
    const f = checkStructure(c).findings;
    assert.ok(f.some((x) => x.code === 'COVERAGE_MISMATCH'));
  });

  test('extending a constructed series behind its inception is caught', () => {
    // exactly what a backward-extension pass will do to GLOBAL_EQUITY
    const c = clone(good());
    c.monthly.GLOBAL_EQUITY = { '2005-01': 1.2, '2005-02': -0.4, ...c.monthly.GLOBAL_EQUITY };
    const f = checkStructure(c).findings;
    const hit = f.find((x) => x.code === 'PRE_INCEPTION_DATA' && x.where === 'monthly.GLOBAL_EQUITY');
    assert.ok(hit, 'pre-2008 GLOBAL_EQUITY must be declared constructed');
    assert.match(hit.message, /CONSTRUCTED/);
  });

  test('a strategy pointing at a missing series is caught', () => {
    const c = clone(good());
    delete c.monthly.TARGET_2060;
    const f = checkStrategyReferences(c, JSON.parse(readFileSync(STRATEGIES, 'utf8')));
    assert.ok(f.some((x) => x.code === 'MISSING_SERIES' && x.message.includes('TARGET_2060')));
  });
});

// -------------------------------------------------------- 3. COMPOSITES ----

describe('cross-series composites', () => {
  test('GLOBAL_EQUITY resolves to a plausible market weight, and to a MOVING one', () => {
    const r = checkComposite(good(), COMPOSITES[0]);
    assert.equal(r.status, 'OK');
    assert.equal(r.months, 199);
    // The pooled weight is now a time-average over sixteen years, so it says
    // less than it used to; it is kept for the identity check and nothing
    // else. The rolling weights are the real measurement.
    assert.ok(r.impliedWeight > 0.45 && r.impliedWeight < 0.65, `pooled w=${r.impliedWeight}`);
    assert.ok(r.rmsBp < 20, `rms ${r.rmsBp}bp`);

    // The US share of world market cap really did run from about 37% to about
    // 63% over 2010-2026. A fit that does not show that is not tracking it.
    assert.ok(r.weightFirst > 0.34 && r.weightFirst < 0.40, `first ${r.weightFirst}`);
    assert.ok(r.weightLast > 0.59 && r.weightLast < 0.66, `last ${r.weightLast}`);
    // the US share should drift upward over this window, as it did
    assert.ok(r.years.at(-1).impliedWeight > r.years[0].impliedWeight);

    // The point of the whole change: no year is now called an error. Under a
    // single pooled weight 2010, 2013, 2024 and 2025 were ERRORs, on data
    // nobody had touched.
    assert.deepEqual(r.findings, []);
    assert.ok(r.years.every((y) => Math.abs(y.diffBp) < 50), 'worst annual disagreement');
  });

  test('a pooled fit is what a drifting weight breaks — the regression this replaced', () => {
    // Pin the failure mode itself, so the rolling fit cannot be quietly
    // reverted to a pooled one without a test saying what that costs.
    const c = good();
    const rolled = checkComposite(c, COMPOSITES[0]);
    const pooled = checkComposite(c, COMPOSITES[0], { windowMonths: 1e6 });
    assert.ok(pooled.rmsBp > 24 && rolled.rmsBp < 18, `${pooled.rmsBp} vs ${rolled.rmsBp}`);
    const worst = (r) => Math.max(...r.years.map((y) => Math.abs(y.diffBp)));
    assert.ok(worst(pooled) > 150, `pooled worst year ${worst(pooled)}bp`);
    assert.ok(worst(rolled) < 50, `rolling worst year ${worst(rolled)}bp`);
    assert.equal(pooled.status, 'FAIL');
    assert.equal(rolled.status, 'OK');
  });

  test('TARGET_2060 resolves to roughly 90% equity', () => {
    const r = checkComposite(good(), COMPOSITES[1]);
    assert.equal(r.status, 'OK');
    assert.ok(Math.abs(r.impliedWeight - 0.90) < 0.05, `w=${r.impliedWeight}`);
  });

  test('a composite swapped for one of its parts is caught by the implied weight', () => {
    const c = clone(good());
    c.monthly.GLOBAL_EQUITY = { ...c.monthly.US_TOTAL }; // someone pasted the wrong column
    const r = checkComposite(c, COMPOSITES[0]);
    assert.equal(r.status, 'FAIL');
    assert.ok(r.impliedWeight > 0.99, `w=${r.impliedWeight}`);
    assert.ok(r.findings.some((f) => f.code === 'IMPLIED_WEIGHT_OFF'));
  });

  test('a price-only composite is caught even with NO annual series to check against', () => {
    // GLOBAL_EQUITY has no annual ground truth. The composite check is the
    // only thing standing between it and a silent price-only substitution.
    const c = clone(good());
    c.monthly.GLOBAL_EQUITY = makePriceOnly(c.monthly.GLOBAL_EQUITY, 2.2);
    const rec = reconcile(c, 'GLOBAL_EQUITY');
    assert.equal(rec.stats.n, 0, 'no annual data, so reconciliation is blind here');

    const r = checkComposite(c, COMPOSITES[0]);
    assert.equal(r.status, 'FAIL');
    // EVERY year, including the partial one, must be over the fail floor —
    // and it is the rolling fit that makes that true. A pooled fit let 2024
    // through at -136bp against a 120bp floor, and a per-year refit lets 2011
    // (-86bp) and 2014 (-113bp) through, because a weight fitted on the same
    // twelve months absorbs the drag it is supposed to expose.
    assert.equal(r.years.length, 17);
    for (const y of r.years) {
      assert.ok(y.diffBp < -COMPOSITE_THRESHOLDS.annualBp,
        `${y.year} only ${y.diffBp.toFixed(0)}bp below its parts`);
    }
    assert.ok(r.years.filter((y) => y.months === 12).every((y) => y.diffBp < -125),
      'every full year should sit well below its parts');
    assert.equal(r.findings.filter((f) => f.code === 'COMPOSITE_YEAR').length, 17);
    assert.equal(runCheck(c).verdict, STATUS.FAIL);

    // A pooled fit is strictly worse at this, which is the false negative the
    // false-positive fix must not have bought.
    const pooled = checkComposite(c, COMPOSITES[0], { windowMonths: 1e6 });
    assert.ok(pooled.years.some((y) => y.diffBp > -COMPOSITE_THRESHOLDS.annualBp - 40),
      'a pooled fit should miss at least one year');
  });

  test('fitWeight recovers a weight it was given', () => {
    const pairs = [];
    for (let i = 0; i < 40; i++) {
      const a = Math.sin(i) * 3;
      const b = Math.cos(i) * 2;
      pairs.push({ a, b, t: 0.63 * a + 0.37 * b });
    }
    assert.ok(Math.abs(fitWeight(pairs) - 0.63) < 1e-9);
  });

  test('rollingWeights recovers a weight that MOVES, which fitWeight cannot', () => {
    // A synthetic 199-month series whose true weight ramps 0.37 -> 0.63, the
    // shape the real US market share has. The pooled fit can only return one
    // number and lands in the middle; the rolling fit tracks the ramp.
    const pairs = [];
    const n = 199;
    for (let i = 0; i < n; i++) {
      const w = 0.37 + (0.63 - 0.37) * (i / (n - 1));
      const a = Math.sin(i) * 4;
      const b = Math.cos(i * 0.7) * 3;
      pairs.push({ key: String(i).padStart(4, '0'), a, b, t: w * a + (1 - w) * b });
    }
    const pooled = fitWeight(pairs);
    assert.ok(Math.abs(pooled - 0.50) < 0.05, `pooled ${pooled}`);

    const local = rollingWeights(pairs, 18);
    assert.equal(local.length, n);
    // Each local fit is within a couple of points of the truth at that month —
    // it cannot be exact, because the weight moves inside the window too.
    for (let i = 0; i < n; i++) {
      const truth = 0.37 + (0.63 - 0.37) * (i / (n - 1));
      assert.ok(Math.abs(local[i] - truth) < 0.03, `month ${i}: ${local[i]} vs ${truth}`);
    }
    // Residuals collapse: pooled leaves the whole ramp in them.
    const resid = (ws) => Math.sqrt(pairs.reduce((acc, p, i) => {
      const w = typeof ws === 'number' ? ws : ws[i];
      return acc + ((p.t - (w * p.a + (1 - w) * p.b)) * 100) ** 2;
    }, 0) / n);
    assert.ok(resid(local) < resid(pooled) / 10, `${resid(local)} vs ${resid(pooled)}`);
  });

  test('a window longer than the data degenerates to the pooled fit', () => {
    const pairs = [];
    for (let i = 0; i < 30; i++) {
      const a = Math.sin(i) * 3;
      const b = Math.cos(i) * 2;
      pairs.push({ key: String(i), a, b, t: 0.58 * a + 0.42 * b });
    }
    for (const w of rollingWeights(pairs, 1000)) {
      assert.ok(Math.abs(w - fitWeight(pairs)) < 1e-12);
    }
  });
});

// -------------------------------------------------------------- 4. DIFF ----

describe('two-source diff', () => {
  test('a file against itself shows nothing', () => {
    const c = good();
    const d = diffSeries(c.monthly.US_500, c.monthly.US_500);
    assert.equal(d.counts.differing, 0);
    assert.equal(d.systematic, null);
  });

  test('a single disagreeing month is located exactly', () => {
    const c = good();
    const b = perturbMonth(c.monthly.US_500, '2024-03', 0.4);
    const d = diffSeries(c.monthly.US_500, b);
    assert.equal(d.counts.differing, 1);
    assert.equal(d.rows[0].key, '2024-03');
    assert.equal(d.rows[0].kind, 'ALARM');
    assert.ok(Math.abs(d.rows[0].bp + 40) < 0.01);
  });

  test('rounding-scale disagreement is below tolerance and stays quiet', () => {
    const c = good();
    const b = Object.fromEntries(Object.entries(c.monthly.US_500)
      .map(([k, v]) => [k, Math.round((v + 0.01) * 100) / 100]));
    const d = diffSeries(c.monthly.US_500, b, { toleranceBp: 2 });
    assert.equal(d.counts.differing, 0);
  });

  test('a price-only second source is called out as a basis difference', () => {
    const c = good();
    const b = makePriceOnly(c.monthly.US_500, 2.4);
    const d = diffSeries(c.monthly.US_500, b);
    assert.ok(d.systematic, 'expected a systematic verdict');
    assert.equal(d.systematic.direction, 'A above B');
    assert.ok(Math.abs(d.systematic.impliedPerYearPct - 2.4) < 0.3,
      `implied ${d.systematic.impliedPerYearPct}pp/yr`);
    assert.match(d.systematic.message, /PRICE-ONLY/);
  });

  test('months present in only one source are reported, not silently dropped', () => {
    const c = good();
    const b = dropMonth(c.monthly.US_500, '2023-06');
    const d = diffSeries(c.monthly.US_500, b);
    assert.equal(d.counts.onlyA, 1);
    assert.equal(d.rows.find((r) => r.kind === 'ONLY_A').key, '2023-06');
  });
});

// ------------------------------------------------------------- 5. OFFLINE ----

describe('offline guarantee', () => {
  test('no source file reaches for the network', () => {
    const files = [
      'verify.mjs', 'src/load.mjs', 'src/reconcile.mjs',
      'src/structure.mjs', 'src/composite.mjs', 'src/diff.mjs', 'src/report.mjs',
      'src/degrade.mjs',
    ];
    const banned = /\b(fetch|XMLHttpRequest|WebSocket)\s*\(|from\s+['"]node:(https?|net|dns|dgram|tls)['"]|require\(['"](https?|net|dns|axios|node-fetch|undici)['"]\)/;
    for (const f of files) {
      const text = readFileSync(join(HERE, '..', f), 'utf8');
      const offending = text.split('\n')
        .map((l, i) => [i + 1, l])
        .filter(([, l]) => banned.test(l) && !l.trimStart().startsWith('//'));
      assert.deepEqual(offending, [], `${f} looks like it touches the network`);
    }
  });

  test('the package declares no dependencies', () => {
    const pkg = JSON.parse(readFileSync(join(HERE, '..', 'package.json'), 'utf8'));
    assert.equal(pkg.dependencies, undefined);
    assert.equal(pkg.devDependencies, undefined);
  });
});
