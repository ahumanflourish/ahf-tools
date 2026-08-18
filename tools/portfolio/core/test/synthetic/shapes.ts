/**
 * Synthetic portfolio shapes — the harness the synthetic suites share.
 *
 * WHY THIS FILE EXISTS, AND WHY IT IS NOT `fixtures.json`.
 *
 * `src/data/fixtures.json` is a real portfolio whose every expected value was
 * independently verified during the original analysis. It is a regression
 * artefact and nothing in this directory may touch it. Its weakness is that it
 * is ONE portfolio: 43 rows, monthly-ish balances, steady contributions, a
 * positive outcome, and a history that happens to start in the first month the
 * benchmark data covers. Passing against it proves the maths, not the tool.
 *
 * Everything here is invented. No value in this file is claimed to be a real
 * market outcome, and nothing here is a benchmark: the balances are chosen to
 * produce a SHAPE — declining, lump-sum, fully withdrawn — and the assertions
 * are about what the engine does with that shape, never about whether the
 * shape is realistic.
 *
 * The two constants that are not invented are `COVERAGE_FIRST_MONTH` and
 * `COVERAGE_LAST_MONTH`, which are facts about `benchmarks.json`.
 */
import { analyse, monthRange } from '../../src/index';
import type {
  AnalysisResult,
  BenchmarkData,
  InputRow,
  PortfolioInput,
  StrategyDef,
} from '../../src/index';

import benchmarksJson from '../../src/data/benchmarks.json' with { type: 'json' };
import strategiesJson from '../../src/data/strategies.json' with { type: 'json' };

export const benchmarks = benchmarksJson as unknown as BenchmarkData;
export const strategies = (strategiesJson as { strategies: unknown[] })
  .strategies as unknown as StrategyDef[];
export const referenceId = (strategiesJson as { defaultReference: string }).defaultReference;

/**
 * Pinned so nothing in these suites can drift with the wall clock. Only the
 * target-year finding reads it, but a suite that is reproducible only until
 * January is not reproducible.
 */
export const NOW = new Date('2026-08-18T00:00:00Z');

export const run = (rows: InputRow[], extra: Partial<PortfolioInput> = {}): AnalysisResult =>
  analyse({ rows, feePct: 0, ...extra }, benchmarks, strategies, referenceId, NOW);

/**
 * Facts about `benchmarks.json`, asserted in `long-history.test.ts`.
 *
 * These are the coverage of the WHOLE catalogue, which is the intersection of
 * the series it uses and so is set by its shortest member. Since v1.1.0 that
 * member is TARGET_2060, which `meta.notes` records as deliberately not
 * extended; five of the seven monthly series now reach back much further
 * (US_500, US_TOTAL and BOND_TOTAL to 1996-01, INTL_TOTAL to 2004-01,
 * GLOBAL_EQUITY to 2010-01). Per-series coverage is pinned in
 * `long-history.test.ts`; do not read the two constants below as the extent
 * of the data.
 */
export const COVERAGE_FIRST_MONTH = '2021-10';
export const COVERAGE_LAST_MONTH = '2026-07';
export const COVERED_MONTHS = monthRange(COVERAGE_FIRST_MONTH, COVERAGE_LAST_MONTH);

/** Last calendar day of a `YYYY-MM`, as ISO. */
export const endOf = (mk: string): string => {
  const [y, m] = mk.split('-').map(Number);
  return new Date(Date.UTC(y, m, 0)).toISOString().slice(0, 10);
};

/** Calendar days between two ISO dates. */
export const days = (a: string, b: string): number =>
  Math.round((Date.parse(`${b}T00:00:00Z`) - Date.parse(`${a}T00:00:00Z`)) / 86400000);

export const balance = (date: string, amount: number): InputRow =>
  ({ date, type: 'balance', amount });
export const contribution = (date: string, amount: number): InputRow =>
  ({ date, type: 'contribution', amount });
export const withdrawal = (date: string, amount: number): InputRow =>
  ({ date, type: 'withdrawal', amount });

/**
 * Compound a strategy's own monthly series over `months`, applying the first
 * month at the half-month convention `replay` uses.
 *
 * A deliberately independent path to a reference ending value for the
 * single-flow shapes: it reads `benchmarks.json` directly and calls neither
 * `buildStrategySeries` nor `replay`. Only valid for a single-weight strategy
 * with `rebalance: 'never'` and a zero expense ratio, which is what
 * `GLOBAL_EQUITY` is — assert that before relying on it.
 */
export function lumpSumForward(seriesId: string, amount: number, months: string[]): number {
  const series = benchmarks.monthly[seriesId];
  let bal = 0;
  months.forEach((mk, i) => {
    const r = series[mk] / 100;
    bal = bal * (1 + r) + (i === 0 ? amount * Math.sqrt(1 + r) : 0);
  });
  return bal;
}

/** Closed-form money-weighted return for a single in, single out. */
export const twoFlowXirr = (from: string, to: string, paid: number, got: number): number =>
  Math.pow(got / paid, 365 / days(from, to)) - 1;

/**
 * Year-end balances at a constant annual growth rate, opening at the first
 * month the benchmark data covers and closing at the last.
 *
 * `rate` may be negative — that is the point of it.
 */
export function yearEndPath(start: number, rate: number): InputRow[] {
  const dates = ['2021-10-31', '2021-12-31', '2022-12-31', '2023-12-31',
                 '2024-12-31', '2025-12-31', '2026-07-31'];
  const t0 = dates[0];
  return dates.map((d) => balance(d, Math.round(start * Math.pow(1 + rate, days(t0, d) / 365) * 100) / 100));
}
