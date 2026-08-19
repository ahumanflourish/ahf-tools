/**
 * The constructed target-date reference.
 *
 * WHY THIS FILE EXISTS. `benchmarks.json` has one target-date series —
 * TARGET_2060, the real VTTSX — and only from 2021-10. Someone who says "I
 * retire in 2035" was being measured against a 2060 fund, and anyone whose
 * history reached back past 2021-10 got no target-date comparison at all.
 * `src/glide.ts` builds one for any year out of Vanguard's own published glide
 * path, and the point of this suite is that a MODELLED series is only worth
 * shipping if it reproduces the one real thing it can be checked against.
 *
 * The acceptance test is `reconciles against the real fund`. If that goes red,
 * the model is wrong and the fix is the model, not the tolerance.
 */
import { describe, it, expect } from 'vitest';

import {
  analyse,
  AnalysisError,
  benchmarkCoverage,
  buildStrategySeries,
  glideWeights,
  scheduleFor,
  decimalYearOfMonthEnd,
  targetDateStrategy,
  targetDateReferences,
  TARGET_DATE_SERIES,
} from '../src/index';
import type {
  BenchmarkData,
  GlidePathData,
  PortfolioInput,
  StrategyDef,
  TargetDateTemplate,
} from '../src/index';

import benchmarksJson from '../src/data/benchmarks.json' with { type: 'json' };
import strategiesJson from '../src/data/strategies.json' with { type: 'json' };
import glideJson from '../src/data/glide-path.json' with { type: 'json' };
import costsJson from '../src/data/target-date-costs.json' with { type: 'json' };

const benchmarks = benchmarksJson as unknown as BenchmarkData;
const glide = glideJson as unknown as GlidePathData;
const template = (strategiesJson as { targetDate: unknown })
  .targetDate as unknown as TargetDateTemplate;

const strategies = (strategiesJson as { strategies: unknown[] })
  .strategies as unknown as StrategyDef[];

const td = (year: number): StrategyDef => targetDateStrategy(year, template, glide);

const months = (from: string, to: string): string[] =>
  Object.keys(benchmarks.monthly.INTL_TOTAL).filter((m) => m >= from && m <= to).sort();

const bp = (a: number, b: number): number => (a - b) * 10000;

// ────────────────────────────────────────────────────── the data itself

describe('the sourced glide path', () => {
  it('cites a filing for every schedule, with no unsourced points', () => {
    expect(glide.schedules.length).toBeGreaterThan(15);
    for (const s of glide.schedules) {
      const src = glide.sources[s.source];
      expect(src, `${s.asOf} has a source`).toBeDefined();
      expect(src.accession, `${s.asOf} accession`).toMatch(/^\d{10}-\d{2}-\d{6}$/);
      expect(src.url).toContain('sec.gov');
      expect(s.points.length).toBeGreaterThanOrEqual(8);
    }
  });

  it('is ascending in t and monotone: less equity the closer the target year', () => {
    for (const s of glide.schedules) {
      for (let i = 1; i < s.points.length; i++) {
        expect(s.points[i].t, `${s.asOf} ordering`).toBeGreaterThan(s.points[i - 1].t);
        // Equal is allowed — a fund that has already reached the Income
        // allocation sits flat against the terminal point. And the older
        // schedules are on the `holdings` basis, which is the real portfolio
        // inside its rebalancing band rather than the target exactly, so two
        // adjacent funds sitting on the flat 90% top can be a few tenths out
        // of order. A whole point would be a parse error; 0.75 is band drift.
        expect(s.points[i].equity, `${s.asOf} monotone at t=${s.points[i].t}`)
          .toBeGreaterThanOrEqual(s.points[i - 1].equity - 0.75);
      }
      expect(s.points[s.points.length - 1].equity).toBeLessThanOrEqual(91);
      expect(s.points[0].equity).toBeGreaterThanOrEqual(29);
    }
  });

  it('records the two changes Vanguard actually made to the equity split', () => {
    // 20% international equity through 2010, 30% from 2010, 40% from 2015.
    // A single fixed split would stamp a 2026 world on 2008; this is the check
    // that the file did not do that.
    const share = (month: string): number =>
      scheduleFor(month, glide).schedule.points.at(-1)!.usEquityShare;
    expect(share('2008-06')).toBeGreaterThan(78);
    expect(share('2013-06')).toBeGreaterThan(68);
    expect(share('2013-06')).toBeLessThan(72);
    expect(share('2019-06')).toBeGreaterThan(58);
    expect(share('2019-06')).toBeLessThan(62);
  });

  it('flags months before the first schedule as extrapolated, and only those', () => {
    expect(scheduleFor('2005-06', glide).extrapolated).toBe(true);
    expect(scheduleFor('2007-06', glide).extrapolated).toBe(false);
    expect(scheduleFor('2026-07', glide).extrapolated).toBe(false);
  });
});

// ──────────────────────────────────────────────────────── the pure function

describe('glideWeights', () => {
  it('produces a complete, non-negative allocation for any year in any month', () => {
    for (const year of [1990, 2015, 2035, 2060, 2075, 2200]) {
      for (const month of ['2004-01', '2010-07', '2020-12', '2026-07']) {
        const w = glideWeights(year, month, glide);
        const total = Object.values(w).reduce((a, b) => a + b, 0);
        expect(total, `${year} ${month} sums to 1`).toBeCloseTo(1, 12);
        for (const [id, v] of Object.entries(w)) {
          expect(v, `${year} ${month} ${id} non-negative`).toBeGreaterThanOrEqual(0);
        }
        expect(Object.keys(w).sort()).toEqual(
          [TARGET_DATE_SERIES.usEquity, TARGET_DATE_SERIES.intlEquity, TARGET_DATE_SERIES.fixedIncome].sort(),
        );
      }
    }
  });

  it('glides: the same fund holds less equity every year that passes', () => {
    let previous = Infinity;
    for (const year of ['2012', '2016', '2020', '2024', '2026']) {
      const w = glideWeights(2035, `${year}-06`, glide);
      const equity = w[TARGET_DATE_SERIES.usEquity] + w[TARGET_DATE_SERIES.intlEquity];
      expect(equity, `2035 fund in ${year}`).toBeLessThan(previous);
      previous = equity;
    }
  });

  it('clamps flat at both ends rather than extrapolating off the ladder', () => {
    const far = glideWeights(2200, '2026-07', glide);
    const farEquity = far[TARGET_DATE_SERIES.usEquity] + far[TARGET_DATE_SERIES.intlEquity];
    expect(farEquity).toBeCloseTo(0.9, 3);

    const past = glideWeights(1950, '2026-07', glide);
    const pastEquity = past[TARGET_DATE_SERIES.usEquity] + past[TARGET_DATE_SERIES.intlEquity];
    expect(pastEquity).toBeCloseTo(0.3, 3);
  });

  it('puts a 2035 retiree somewhere sane, and nowhere near the 2060 fund', () => {
    const near = glideWeights(2035, '2026-07', glide);
    const far = glideWeights(2060, '2026-07', glide);
    const eq = (w: Record<string, number>) =>
      w[TARGET_DATE_SERIES.usEquity] + w[TARGET_DATE_SERIES.intlEquity];
    expect(eq(near)).toBeGreaterThan(0.6);
    expect(eq(near)).toBeLessThan(0.72);
    expect(eq(far)).toBeCloseTo(0.9, 2);
    // The whole reason this exists: the substitution being replaced was worth
    // more than 20 percentage points of equity.
    expect(eq(far) - eq(near)).toBeGreaterThan(0.2);
  });

  it('decimalYearOfMonthEnd lands on the month end, not the month start', () => {
    // 31 January is 30 days after 1 January, not 31.
    expect(decimalYearOfMonthEnd('2026-01')).toBeCloseTo(2026 + 30 / 365, 6);
    // and 31 December is one day short of the next year, not on it.
    expect(decimalYearOfMonthEnd('2026-12')).toBeCloseTo(2027 - 1 / 365, 6);
  });
});

// ────────────────────────────────────────── the acceptance test: ground truth

describe('reconciles against the real fund', () => {
  const real = benchmarks.monthly.TARGET_2060;
  const realMonths = Object.keys(real).sort();
  const constructed = td(2060);
  const series = buildStrategySeries(constructed, benchmarks, realMonths);

  it('matches VTTSX month by month to a tolerance the shipped data itself sets', () => {
    const residuals = realMonths.map((m) => (series[m] - real[m]) * 100);
    const mean = residuals.reduce((a, b) => a + b, 0) / residuals.length;
    const rms = Math.sqrt(residuals.reduce((a, b) => a + b * b, 0) / residuals.length);
    // benchmarks.json's own notes record a constructed GLOBAL_EQUITY measured
    // at 18.2bp rms a month and judged methodologically sound. This is inside
    // that, on a series with a real fund to check against rather than a fitted
    // anchor.
    expect(rms, `rms ${rms.toFixed(2)}bp`).toBeLessThan(15);
    expect(Math.abs(mean), `mean ${mean.toFixed(2)}bp`).toBeLessThan(2);
  });

  it('has no one-directional bias — the price-only failure mode', () => {
    // A price-return series would sit below a total-return one by the dividend
    // yield, every month, at 1.5-4pp a year. Half the months below would be
    // chance; 58 of 58 would not.
    const below = realMonths.filter((m) => series[m] < real[m]).length;
    expect(below).toBeGreaterThan(realMonths.length * 0.3);
    expect(below).toBeLessThan(realMonths.length * 0.7);
  });

  it('compounds onto the real fund within 15bp in every calendar year', () => {
    const years = [...new Set(realMonths.map((m) => m.slice(0, 4)))];
    for (const y of years) {
      const ms = realMonths.filter((m) => m.startsWith(y));
      const grow = (pick: (m: string) => number) =>
        ms.reduce((p, m) => p * (1 + pick(m) / 100), 1) - 1;
      const diff = bp(grow((m) => series[m]), grow((m) => real[m]));
      expect(Math.abs(diff), `${y} residual ${diff.toFixed(1)}bp`).toBeLessThan(15);
    }
  });

  it('is a genuinely independent path, not a copy of the real series', () => {
    // A tolerance test passes trivially if the two series are the same object.
    const exact = realMonths.filter((m) => series[m] === real[m]).length;
    expect(exact).toBeLessThan(realMonths.length * 0.2);
  });
});

// ───────────────────────────────────────────────── the catalogue entry

describe('targetDateStrategy', () => {
  it('is labelled as constructed, in a field a UI cannot quietly drop', () => {
    const s = td(2035);
    expect(s.constructed).toBeTruthy();
    expect(s.constructed).toContain('2035');
    // Belt and braces: `caution` is already mandated visible by SPEC, so the
    // fact is carried there too.
    expect(s.caution).toBeTruthy();
    expect(s.caution!.toLowerCase()).toContain('not a real fund');
    expect(s.label).toContain('modelled');
  });

  it('still carries the 401k expense-ratio caution on top', () => {
    expect(td(2040).caution).toContain('expense ratio');
  });

  it('names its component funds so the all-in cost resolves', () => {
    const s = td(2045);
    for (const id of Object.keys(s.weights)) {
      const fund = s.funds!.find((f) => f.series === id && f.basis === 'monthly');
      expect(fund, `monthly fund for ${id}`).toBeDefined();
      expect(fund!.expenseRatio).toBeTypeOf('number');
      expect(fund!.asOf).toBeTruthy();
    }
    expect(s.expenseRatio).toBe(0);
  });

  it('gives every year its own id and label, including years off the five-year grid', () => {
    expect(td(2037).id).toBe('TARGET_DATE_2037');
    expect(td(2037).label).toContain('2037');
    expect(td(2037).id).not.toBe(td(2038).id);
  });

  it('refuses a year that is not a whole year', () => {
    expect(() => targetDateStrategy(2035.5, template, glide)).toThrow(/whole year/);
  });

  it('declares all three series in `weights`, which is what coverage reads', () => {
    const s = td(2035);
    expect(Object.keys(s.weights).sort()).toEqual(
      [TARGET_DATE_SERIES.usEquity, TARGET_DATE_SERIES.intlEquity, TARGET_DATE_SERIES.fixedIncome].sort(),
    );
    expect(Object.values(s.weights).reduce((a, b) => a + b, 0)).toBeCloseTo(1, 12);
  });
});

// ────────────────────────────────────────────── the engine, end to end

describe('buildStrategySeries with a moving target', () => {
  it('leaves the static path alone — a constant weightsAt equals no weightsAt', () => {
    const base = strategies.find((s) => s.id === 'GLOBAL_6040')!;
    const withFn: StrategyDef = { ...base, weightsAt: () => base.weights };
    const ms = months('2010-01', '2026-07');
    const a = buildStrategySeries(base, benchmarks, ms);
    const b = buildStrategySeries(withFn, benchmarks, ms);
    for (const m of ms) expect(b[m], m).toBeCloseTo(a[m], 12);
  });

  it('actually moves — the same months priced for two retirement years differ', () => {
    const ms = months('2010-01', '2026-07');
    const near = buildStrategySeries(td(2020), benchmarks, ms);
    const far = buildStrategySeries(td(2060), benchmarks, ms);
    const differing = ms.filter((m) => Math.abs(near[m] - far[m]) > 0.01).length;
    expect(differing).toBeGreaterThan(ms.length * 0.9);
  });

  it('applies extra drag the same way the static path does', () => {
    const ms = months('2015-01', '2020-12');
    const free = buildStrategySeries(td(2050), benchmarks, ms);
    const charged = buildStrategySeries({ ...td(2050), expenseRatio: 0.01 }, benchmarks, ms);
    const grow = (s: Record<string, number>) => ms.reduce((p, m) => p * (1 + s[m] / 100), 1);
    expect(grow(free) / grow(charged)).toBeCloseTo(Math.pow(1 / (1 - 0.01), ms.length / 12), 6);
  });
});

describe('coverage and analyse', () => {
  it('pushes the earliest supported date back from 2021-10 to 2004-01', () => {
    const realOnly = strategies.filter((s) => s.id === 'TARGET_2060');
    expect(benchmarkCoverage(benchmarks, realOnly)!.firstMonth).toBe('2021-10');
    expect(benchmarkCoverage(benchmarks, [td(2035)])!.firstMonth).toBe('2004-01');
  });

  it('analyses a history that the real 2060 fund could not have covered', () => {
    const input: PortfolioInput = {
      rows: [
        { date: '2006-01-31', type: 'contribution', amount: 20000 },
        { date: '2006-12-31', type: 'balance', amount: 22000 },
        { date: '2015-12-31', type: 'balance', amount: 40000 },
        { date: '2024-12-31', type: 'balance', amount: 95000 },
      ],
      feePct: 0.01,
      statedTargetYear: 2035,
    };
    const r = analyse(input, benchmarks, [td(2035)], 'TARGET_DATE_2035');
    expect(r.strategies).toHaveLength(1);
    expect(r.strategies[0].endingValue).toBeGreaterThan(20000);
    expect(Number.isFinite(r.strategies[0].xirr)).toBe(true);
    // And the same history against the real 2060 fund still refuses, loudly.
    expect(() => analyse(input, benchmarks, strategies.filter((s) => s.id === 'TARGET_2060'), 'TARGET_2060'))
      .toThrow(AnalysisError);
  });

  it('measures a 2035 retiree against a 2035 path, not the 2060 one', () => {
    const input: PortfolioInput = {
      rows: [
        { date: '2010-01-31', type: 'contribution', amount: 50000 },
        { date: '2010-01-31', type: 'balance', amount: 50000 },
        { date: '2026-07-31', type: 'balance', amount: 150000 },
      ],
      feePct: 0,
      statedTargetYear: 2035,
    };
    const r = analyse(input, benchmarks, [td(2035), td(2060)], 'TARGET_DATE_2035');
    const near = r.strategies.find((s) => s.id === 'TARGET_DATE_2035')!;
    const far = r.strategies.find((s) => s.id === 'TARGET_DATE_2060')!;
    // 2010-2026 was a strong stretch for equities, so the more aggressive path
    // ends higher — which is exactly why substituting it was unfair.
    expect(far.endingValue).toBeGreaterThan(near.endingValue);
    expect(far.endingValue / near.endingValue).toBeGreaterThan(1.1);
  });
});

// ─────────────────── the honest limit: where the approximation gets dear

describe('the three-sleeve approximation, priced', () => {
  it('is tight on a long-dated fund and demonstrably looser on a near one', () => {
    // benchmarks.json has no short-term TIPS series and no hedged
    // international bond series, so both are modelled as US investment-grade
    // bonds. This asserts the SHAPE of that error, because a suite that only
    // checked the 2060 case would be checking the easy half.
    const real2060 = benchmarks.monthly.TARGET_2060;
    const ms = Object.keys(real2060).sort();
    const spread = (year: number) => {
      const s = buildStrategySeries(td(year), benchmarks, ms);
      const w = glideWeights(year, ms[Math.floor(ms.length / 2)], glide);
      return { bondShare: w[TARGET_DATE_SERIES.fixedIncome], series: s };
    };
    expect(spread(2060).bondShare).toBeLessThan(0.12);
    expect(spread(2025).bondShare).toBeGreaterThan(0.35);
    // The near-dated path is genuinely a different, more conservative animal.
    const vol = (s: Record<string, number>) => {
      const v = ms.map((m) => s[m]);
      const mean = v.reduce((a, b) => a + b, 0) / v.length;
      return Math.sqrt(v.reduce((a, b) => a + (b - mean) ** 2, 0) / v.length);
    };
    expect(vol(spread(2025).series)).toBeLessThan(vol(spread(2060).series));
  });
});

describe('targetDateReferences — the real fund or the model, or both', () => {
  it('offers the real 2060 fund first, and the model behind it', () => {
    const refs = targetDateReferences(2060, template, glide, strategies);
    expect(refs.map((s) => s.id)).toEqual(['TARGET_2060', 'TARGET_DATE_2060']);
    expect(refs[0].constructed).toBeUndefined();
    expect(refs[1].constructed).toBeTruthy();
  });

  it('offers only the model for a year no real fund covers', () => {
    expect(targetDateReferences(2035, template, glide, strategies).map((s) => s.id))
      .toEqual(['TARGET_DATE_2035']);
  });

  it('is why both are offered: they support different windows', () => {
    const [real, model] = targetDateReferences(2060, template, glide, strategies);
    expect(benchmarkCoverage(benchmarks, [real])!.firstMonth).toBe('2021-10');
    expect(benchmarkCoverage(benchmarks, [model])!.firstMonth).toBe('2004-01');
  });

  it('the gap between the two IS the model error, and it is small', () => {
    const [real, model] = targetDateReferences(2060, template, glide, strategies);
    const ms = Object.keys(benchmarks.monthly.TARGET_2060).sort();
    const grow = (d: StrategyDef) => {
      const s = buildStrategySeries(d, benchmarks, ms);
      return ms.reduce((p, m) => p * (1 + s[m] / 100), 1);
    };
    // Under 40bp of divergence over 58 months, on a 58% cumulative return.
    expect(Math.abs(bp(grow(model), grow(real)))).toBeLessThan(40);
  });

  it('works with no catalogue at all', () => {
    expect(targetDateReferences(2045, template, glide)).toHaveLength(1);
  });
});


// ───────────────────── the provider cost lookup, and what it must not become

describe('target-date-costs.json', () => {
  const rows = costsJson.providers;

  it('is fractions, not percents — the 100x error that would be catastrophic', () => {
    for (const r of rows) {
      expect(r.expenseRatio, `${r.ticker} gross`).toBeGreaterThan(0);
      expect(r.expenseRatio, `${r.ticker} gross`).toBeLessThan(0.03);
      expect(r.expenseRatioNet, `${r.ticker} net`).toBeGreaterThan(0);
      expect(r.expenseRatioNet, `${r.ticker} net`).toBeLessThanOrEqual(r.expenseRatio);
    }
  });

  it('cites an SEC accession and a date for every figure', () => {
    for (const r of rows) {
      expect(r.source, `${r.ticker}`).toMatch(/\d{10}-\d{2}-\d{6}/);
      expect(r.asOf, `${r.ticker}`).toMatch(/^\d{4}-\d{2}-\d{2}$/);
      // The citation of record is the accession asserted above. The URL only
      // has to be an ISSUER document — EDGAR, or the issuer's own site. An
      // aggregator here would be the exact sourcing failure this project has
      // thrown work away over four times.
      expect(r.url, `${r.ticker}`).toMatch(/^(www\.sec\.gov|[a-z0-9.-]*vanguard\.com)\//);
    }
  });

  it('spans the range that makes the input worth having at all', () => {
    // 0.08% to 0.83%. Measuring someone against the cheapest fund in the
    // category when their plan only offered an expensive one manufactures a
    // grievance, which is the thing SPEC non-negotiable 3 forbids.
    const cheapest = Math.min(...rows.map((r) => r.expenseRatioNet));
    const dearest = Math.max(...rows.map((r) => r.expenseRatio));
    expect(cheapest).toBeLessThanOrEqual(0.0009);
    expect(dearest).toBeGreaterThanOrEqual(0.008);
    expect(dearest / cheapest).toBeGreaterThan(9);
  });

  it('offers both an index and an active variant where a provider has both', () => {
    const byProvider = new Map<string, Set<string>>();
    for (const r of rows) {
      if (!byProvider.has(r.provider)) byProvider.set(r.provider, new Set());
      byProvider.get(r.provider)!.add(r.kind);
    }
    const bothSides = [...byProvider.values()].filter(
      (k) => k.has('index') && (k.has('active') || k.has('blend')),
    );
    expect(bothSides.length).toBeGreaterThanOrEqual(4);
  });

  it('never gets mistaken for the user\'s own fee', () => {
    // Different question, different field. `feePct` is what the USER pays;
    // this is what the REFERENCE would have cost. Conflating them corrupts
    // `fee-minority`, which asks what share of the gap the user's fee explains.
    const text = JSON.stringify(costsJson.meta);
    expect(text).toContain('feePct');
    expect(text).toContain('expenseRatios');
  });
});
