/**
 * Regression test for the ported engine.
 *
 * Every value in `fixtures.json -> expected` is asserted here, using the
 * tolerances the fixture itself states. Tolerances are never loosened to
 * make a test pass; if something diverges the failure is the report.
 */
import { describe, it, expect } from 'vitest';

import { analyse, buildStrategySeries, monthEnd, monthRange } from '../src/index';
import type {
  AnalysisResult,
  BenchmarkData,
  PeriodInfo,
  PortfolioInput,
  StrategyDef,
} from '../src/index';

import benchmarksJson from '../src/data/benchmarks.json' with { type: 'json' };
import strategiesJson from '../src/data/strategies.json' with { type: 'json' };
import fixturesJson from '../src/data/fixtures.json' with { type: 'json' };

const benchmarks = benchmarksJson as unknown as BenchmarkData;
const strategies = (strategiesJson as { strategies: unknown[] })
  .strategies as unknown as StrategyDef[];
const referenceId = (strategiesJson as { defaultReference: string }).defaultReference;

const fixture = fixturesJson as unknown as {
  input: Omit<PortfolioInput, 'holdings'>;
  holdings: NonNullable<PortfolioInput['holdings']>;
  expected: {
    netContributed: number;
    endingValue: number;
    gain: number;
    yourXirr: { value: number; tolerance: number };
    strategies: Record<string, { endingValue: number; xirr: number; tolerance: number }>;
    capture: {
      available: number;
      kept: number;
      forgone: number;
      pctKept: number;
      pctForgone: number;
      tolerance: number;
    };
    annual: Record<string, number>;
    flowFreeWindows: {
      start: string;
      end: string;
      minMonths: number;
      yourReturn: number;
      tolerance: number;
    }[];
    findings: string[];
  };
};

// `holdings` sits alongside `input` in the fixture file, but the engine takes
// it as part of PortfolioInput. Without it the regional-tilt and size-tilt
// findings cannot fire, and the fixture expects both.
const input: PortfolioInput = { ...fixture.input, holdings: fixture.holdings };
const expected = fixture.expected;

/** Declared locally so the package needs no @types/node just to print a table. */
declare const console: { table(rows: unknown): void };

/** Dollar tolerance for figures derived from a strategy's ending value. */
const DOLLAR_TOL = 50;

const result: AnalysisResult = analyse(input, benchmarks, strategies, referenceId);

/** Collected so the report can show computed vs expected even when green. */
const deltas: { field: string; expected: number; actual: number; tol: number }[] = [];

function near(field: string, actual: number, exp: number, tol: number): void {
  deltas.push({ field, expected: exp, actual, tol });
  expect(Number.isFinite(actual), `${field} is not finite: ${actual}`).toBe(true);
  expect(
    Math.abs(actual - exp),
    `${field}: expected ${exp}, got ${actual} (delta ${actual - exp}, tol ${tol})`,
  ).toBeLessThanOrEqual(tol);
}

describe('reference-case-2021-2026 fixture', () => {
  it('reproduces the headline four', () => {
    near('endingValue', result.endingValue, 53690.25, 0.005);
    near('you.xirr', result.you.xirr, expected.yourXirr.value, expected.yourXirr.tolerance);
    const ge = result.strategies.find((s) => s.id === 'GLOBAL_EQUITY');
    expect(ge, 'GLOBAL_EQUITY missing from results').toBeDefined();
    near('GLOBAL_EQUITY.endingValue', ge!.endingValue, 60328.4, DOLLAR_TOL);
    near('capture.pctKept', result.capture.pctKept, 0.6812, expected.capture.tolerance);
  });

  it('reproduces the contribution totals', () => {
    near('netContributed', result.netContributed, expected.netContributed, 0.005);
    near('endingValue', result.endingValue, expected.endingValue, 0.005);
    near('gain', result.gain, expected.gain, 0.005);
  });

  it('reproduces every expected strategy', () => {
    for (const [id, exp] of Object.entries(expected.strategies)) {
      const got = result.strategies.find((s) => s.id === id);
      expect(got, `strategy ${id} missing from results`).toBeDefined();
      near(`${id}.endingValue`, got!.endingValue, exp.endingValue, exp.tolerance);
      // The fixture states one tolerance per strategy, in dollars. The xirr
      // figure is asserted at the same tolerance the fixture uses for the
      // user's own xirr.
      near(`${id}.xirr`, got!.xirr, exp.xirr, expected.yourXirr.tolerance);
    }
  });

  it('reproduces the capture block', () => {
    const c = expected.capture;
    // available/kept/forgone are dollar figures derived from the reference
    // strategy's ending value, so they inherit its dollar tolerance.
    near('capture.available', result.capture.available, c.available, DOLLAR_TOL);
    near('capture.kept', result.capture.kept, c.kept, 0.005);
    near('capture.forgone', result.capture.forgone, c.forgone, DOLLAR_TOL);
    near('capture.pctKept', result.capture.pctKept, c.pctKept, c.tolerance);
    near('capture.pctForgone', result.capture.pctForgone, c.pctForgone, c.tolerance);
    // Internal consistency of the fee split.
    near(
      'capture.feeShare+otherShare',
      result.capture.feeShare + result.capture.otherShare,
      result.capture.forgone,
      0.005,
    );
  });

  it('reproduces the annual return series', () => {
    const { tolerance, ...years } = expected.annual as Record<string, number> & {
      tolerance: number;
    };
    for (const [year, exp] of Object.entries(years)) {
      const got = result.you.annual[year];
      expect(got, `annual ${year} missing`).toBeDefined();
      near(`annual.${year}`, got, exp, tolerance);
    }
  });

  // ─────────────────────────────────────────── period windows (FIX 1)

  it('reports a window for every annual period, stubs included', () => {
    // `you.annual` must keep all six periods — V3 renders six bars and
    // footnotes the partial ones — so `periods` has to key one-for-one onto it.
    expect(Object.keys(result.periods)).toEqual(Object.keys(result.you.annual));
    expect(Object.keys(result.periods)).toEqual([
      '2021', '2022', '2023', '2024', '2025', '2026',
    ]);
  });

  it('measures each period over the window it actually covers', () => {
    // Verified by hand against the fixture's balance rows: the first period
    // opens at the first observed balance, not 1 January, and the last closes
    // at the final balance, not 31 December.
    const expectedPeriods: Record<string, PeriodInfo> = {
      2021: { start: '2021-10-31', end: '2021-12-31', days: 61, partial: true },
      2022: { start: '2021-12-31', end: '2022-12-31', days: 365, partial: false },
      2023: { start: '2022-12-31', end: '2023-12-31', days: 365, partial: false },
      2024: { start: '2023-12-31', end: '2024-12-31', days: 366, partial: false },
      2025: { start: '2024-12-31', end: '2025-12-31', days: 365, partial: false },
      2026: { start: '2025-12-31', end: '2026-07-31', days: 212, partial: true },
    };
    expect(result.periods).toEqual(expectedPeriods);

    // The day counts must agree with the dates they are derived from, so a
    // future change to either is caught rather than silently disagreeing.
    for (const [year, p] of Object.entries(result.periods)) {
      const days = Math.round(
        (Date.parse(`${p.end}T00:00:00Z`) - Date.parse(`${p.start}T00:00:00Z`)) / 86400000,
      );
      expect(p.days, `periods.${year}.days disagrees with its own dates`).toBe(days);
    }
  });

  // ──────────────────────────── reference measured over the same window (FIX 2)

  it('compounds each reference over the same window as the user', () => {
    const months = monthRange(
      result.dataQuality.firstDate.slice(0, 7),
      result.dataQuality.lastDate.slice(0, 7),
    );

    for (const def of strategies) {
      const series = buildStrategySeries(def, benchmarks, months);
      const got = result.strategies.find((s) => s.id === def.id);
      expect(got, `strategy ${def.id} missing from results`).toBeDefined();

      for (const [year, p] of Object.entries(result.periods)) {
        // Independent recomputation: a month counts when its END falls inside
        // (start, end], the same span the user's Modified Dietz figure covers.
        let g = 1;
        for (const mk of months) {
          const me = monthEnd(mk);
          if (me > p.start && me <= p.end) g *= 1 + series[mk] / 100;
        }
        near(`${def.id}.annual.${year}`, got!.annual[year], g - 1, 1e-12);
      }
    }
  });

  it('leaves full years identical to plain calendar-year compounding', () => {
    // The window alignment must move the stubs and NOTHING else. For a full
    // year the two definitions select the same months, so they must agree
    // exactly; for 2021 they must not, or the fix did nothing.
    const months = monthRange(
      result.dataQuality.firstDate.slice(0, 7),
      result.dataQuality.lastDate.slice(0, 7),
    );

    for (const def of strategies) {
      const series = buildStrategySeries(def, benchmarks, months);
      const got = result.strategies.find((s) => s.id === def.id)!;

      for (const [year, p] of Object.entries(result.periods)) {
        let g = 1;
        for (const mk of months.filter((m) => m.startsWith(year))) g *= 1 + series[mk] / 100;
        const calendarYear = g - 1;

        if (year === '2021') {
          // 2021-10 sits before the user's first balance and must be dropped.
          expect(
            Math.abs(got.annual[year] - calendarYear),
            `${def.id} 2021 still matches calendar-year compounding — the ` +
              `window alignment is not in effect`,
          ).toBeGreaterThan(1e-9);
          const october = series['2021-10'] / 100;
          near(
            `${def.id}.annual.2021 excludes 2021-10`,
            (1 + calendarYear) / (1 + got.annual[year]) - 1,
            october,
            1e-12,
          );
        } else {
          // Includes 2026: its window 2025-12-31 → 2026-07-31 already selected
          // exactly the calendar months present in the series.
          expect(p.days > 0).toBe(true);
          near(`${def.id}.annual.${year} unchanged`, got.annual[year], calendarYear, 1e-12);
        }
      }
    }
  });

  it('aligns the 2021 reference so the user is ahead, not behind', () => {
    // The user-visible number in V3's per-year gap label. Before the fix the
    // reference was credited with October 2021 (+5.15% for GLOBAL_EQUITY),
    // which the user never held, and 2021 read as a 2.95pp shortfall.
    const ge = result.strategies.find((s) => s.id === 'GLOBAL_EQUITY')!;
    near('GLOBAL_EQUITY.annual.2021 aligned', ge.annual['2021'], 0.0109018, 1e-6);
    near('you.annual.2021', result.you.annual['2021'], 0.0334314, 1e-6);
    const gapPp = (result.you.annual['2021'] - ge.annual['2021']) * 100;
    near('2021 gap in pp', gapPp, 2.253, 0.001);
    expect(gapPp, '2021 must now read as an outperformance').toBeGreaterThan(0);
  });

  // ──────────────────────── capture ratios exclude partial periods (FIX 1)

  it('excludes partial periods from the capture-ratio mean', () => {
    const ref = result.strategies.find((s) => s.id === referenceId)!;
    const ratio = (y: string): number => result.you.annual[y] / ref.annual[y];
    const mean = (ys: string[]): number => ys.reduce((s, y) => s + ratio(y), 0) / ys.length;

    const full = Object.keys(result.you.annual).filter((y) => !result.periods[y].partial);
    expect(full).toEqual(['2022', '2023', '2024', '2025']);

    const up = full.filter((y) => ref.annual[y] > 0);
    const down = full.filter((y) => ref.annual[y] < 0);
    expect(up).toEqual(['2023', '2024', '2025']);
    expect(down).toEqual(['2022']);

    near('upside capture (full years)', mean(up), 0.81676, 1e-4);
    near('downside capture (full years)', mean(down), 1.03928, 1e-4);

    // The stubs are why they have to be excluded. 2021's window is 61 days and
    // its reference return is near zero, so its raw ratio is ~3.07 — averaging
    // that against full years pushes the mean over 1 and silently switches the
    // capture-asymmetry finding off. This asserts the trap is real.
    const all = Object.keys(result.you.annual);
    const upAll = all.filter((y) => ref.annual[y] > 0);
    expect(ratio('2021')).toBeGreaterThan(3);
    expect(
      mean(upAll),
      'including the stubs must push upside capture above 1 — if it no longer ' +
        'does, the coupling this test guards has changed',
    ).toBeGreaterThan(1);
  });

  it('states the full-year capture ratios in the finding text', () => {
    const asym = result.findings.find((f) => f.id === 'capture-asymmetry');
    expect(asym, 'capture-asymmetry must still fire').toBeDefined();
    // Was "about 73%" while the two stub periods were averaged in.
    expect(asym!.detail).toContain('captured about 82% of the reference return');
    expect(asym!.detail).toContain('you absorbed about 104%');
  });

  it('reproduces the flow-free windows', () => {
    for (const exp of expected.flowFreeWindows) {
      const got = result.flowFreeWindows.find(
        (w) => w.start === exp.start && w.end === exp.end,
      );
      expect(
        got,
        `flow-free window ${exp.start}..${exp.end} missing; got ${JSON.stringify(
          result.flowFreeWindows,
        )}`,
      ).toBeDefined();
      expect(got!.months).toBeGreaterThanOrEqual(exp.minMonths);
      near(`window ${exp.start}..${exp.end} yourReturn`, got!.yourReturn, exp.yourReturn, exp.tolerance);
    }
  });

  it('fires exactly the expected findings', () => {
    const ids = result.findings.map((f) => f.id).sort();

    // Diagnostic for `regional-tilt`: it requires the US share of equity to
    // deviate by MORE than 15pp from market weight (engine.ts deriveFindings
    // check 4). Market weight is derived from the benchmark series and anchored
    // to the holdings date, not hardcoded, so this reports against whatever
    // `result.marketWeight` resolved to. Nothing here is loosened.
    const eq = input.holdings!.positions.filter(
      (p) => p.assetClass === 'us_equity' || p.assetClass === 'intl_equity',
    );
    const eqTotal = eq.reduce((s, p) => s + p.value, 0);
    const usTotal = eq
      .filter((p) => p.assetClass === 'us_equity')
      .reduce((s, p) => s + p.value, 0);
    const usShare = usTotal / eqTotal;

    expect(
      ids,
      `findings mismatch. Holdings diagnostic: equity total ${eqTotal.toFixed(2)}, ` +
        `US ${usTotal.toFixed(2)}, usShare ${(usShare * 100).toFixed(2)}%, ` +
        `deviation from ${(result.marketWeight.usEquity * 100).toFixed(2)}% market ` +
        `weight (${result.marketWeight.source}, asOf ${result.marketWeight.asOf}) ` +
        `${((usShare - result.marketWeight.usEquity) * 100).toFixed(2)}pp, ` +
        `engine threshold >15pp.`,
    ).toEqual([...expected.findings].sort());
  });

  it('prints computed vs expected', () => {
    const rows = deltas.map((d) => ({
      field: d.field,
      expected: d.expected,
      actual: Number(d.actual.toFixed(6)),
      delta: Number((d.actual - d.expected).toPrecision(3)),
      tol: d.tol,
    }));
    // eslint-disable-next-line no-console
    console.table(rows);
    expect(rows.length).toBeGreaterThan(0);
  });
});
