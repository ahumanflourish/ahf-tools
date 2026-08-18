/**
 * Long histories, and the 30-year gap that blocks them.
 *
 * THE BLOCKER, stated once, in full.
 *
 * `benchmarks.json` carries ANNUAL returns for 1996-2026 but MONTHLY returns
 * only for 2021-10 through 2026-07. `analyse` needs monthly data for every
 * month it spans, so the earliest history it can compute on begins
 * **2021-10-01** and the latest ends **2026-07-31**. Anything outside that is
 * blocked on data, not on code. SPEC.md carries it as open decision 1 —
 * extend the monthly series backwards (preferred), or fall back to annual
 * granularity with a label — and both are separate, already-planned work.
 *
 * WHAT THIS FILE DOES ABOUT IT.
 *
 *  - The long-history tests are written out in full and marked `it.skip`.
 *    They are the specification of what "a 10-year history works" has to
 *    mean, and they are here so that the person extending the data has an
 *    acceptance test waiting rather than a blank page. No benchmark data is
 *    faked to make them pass and none of them is weakened.
 *  - Everything asserting TODAY'S behaviour runs normally. A history outside
 *    coverage must fail the way INTERACTION.md requires — "name the earliest
 *    supported date and offer to analyse the covered portion" — rather than
 *    crashing out of `buildStrategySeries`, which is what it did before.
 *  - A tripwire test asserts the blocker is still real. When the monthly data
 *    is extended it will fail, and its message says to un-skip this file.
 *
 * So: a skipped test here means BLOCKED ON DATA. A failing test here means
 * something is broken.
 */
import { describe, it, expect } from 'vitest';

import { AnalysisError, analyse, benchmarkCoverage, monthRange } from '../src/index';
import type { InputRow, StrategyDef } from '../src/index';

import {
  COVERAGE_FIRST_MONTH, COVERAGE_LAST_MONTH, NOW, balance, benchmarks,
  contribution, endOf, referenceId, run, strategies,
} from './synthetic/shapes';

const EARLIEST_SUPPORTED = '2021-10-01';
const LATEST_SUPPORTED = '2026-07-31';

const caught = (rows: InputRow[]): AnalysisError => {
  try { run(rows); } catch (e) { return e as AnalysisError; }
  throw new Error('expected analyse to throw');
};

// ═════════════════════════════════════════════ the blocker, asserted as fact

describe('benchmark coverage', () => {
  it('is exactly 2021-10 .. 2026-07 monthly', () => {
    const cov = benchmarkCoverage(benchmarks, strategies)!;
    expect(cov.firstMonth).toBe(COVERAGE_FIRST_MONTH);
    expect(cov.lastMonth).toBe(COVERAGE_LAST_MONTH);
    // Contiguous — no interior holes, which the guard in `analyse` assumes
    // and `buildStrategySeries` would otherwise catch far too late.
    const want = monthRange(cov.firstMonth, cov.lastMonth);
    for (const id of new Set(strategies.flatMap((s) => Object.keys(s.weights)))) {
      expect(Object.keys(benchmarks.monthly[id]).sort()).toEqual(want);
    }
  });

  it('TRIPWIRE: extending the monthly data un-blocks the skipped tests below', () => {
    // This test exists to fail. When someone completes SPEC.md open decision 1
    // and the monthly series reaches back past 2021-10, this assertion breaks
    // — and that is the signal to remove the `.skip` from every test in this
    // file marked BLOCKED, not to change the number here.
    const cov = benchmarkCoverage(benchmarks, strategies)!;
    expect(
      cov.firstMonth,
      'Monthly benchmark coverage now starts earlier than 2021-10. The long-history ' +
      'tests in this file are no longer blocked — un-skip them and delete this tripwire.',
    ).toBe('2021-10');
  });

  it('narrows to the series the given strategies actually use', () => {
    // A catalogue entry nobody selected must not shorten anyone's supported
    // range. Verified with a strategy pointing at a series that does not exist.
    const phantom: StrategyDef = {
      id: 'PHANTOM', label: 'Phantom', weights: { NOT_A_SERIES: 1 },
      expenseRatio: 0, rebalance: 'never', explainer: '',
    };
    expect(benchmarkCoverage(benchmarks, [phantom])).toBe(null);
    expect(benchmarkCoverage(benchmarks, [])).toBe(null);
    const bondsOnly = strategies.filter((s) => s.id === 'ALL_BONDS');
    expect(benchmarkCoverage(benchmarks, bondsOnly)!.firstMonth).toBe('2021-10');
  });
});

// ═════════════════════════════════ today's behaviour outside coverage

describe('a history outside benchmark coverage fails informatively', () => {
  // INTERACTION.md, error table: "History predates benchmark coverage — name
  // the earliest supported date and offer to analyse the covered portion."
  //
  // Before this work the failure was `Error: missing monthly GLOBAL_EQUITY
  // 2019-01`, thrown three frames down inside `buildStrategySeries`. It named
  // an internal series id, not a date the user could act on; it gave a UI
  // nothing to branch on; and it is not a sentence anyone should ever read.

  it('names the earliest supported date for a pre-2021-10 history', () => {
    const err = caught([
      contribution('2019-01-15', 10_000),
      balance('2019-01-31', 10_000),
      balance('2026-07-31', 30_000),
    ]);
    expect(err).toBeInstanceOf(AnalysisError);
    expect(err.code).toBe('history-before-coverage');
    expect(err.earliestSupported).toBe(EARLIEST_SUPPORTED);
    expect(err.message).toContain('2019-01-15');
    expect(err.message).toContain(EARLIEST_SUPPORTED);
    // Not the internal message it used to leak.
    expect(err.message).not.toContain('missing monthly');
    expect(err.message).not.toContain('GLOBAL_EQUITY');
  });

  it('offers the covered portion, with both ends of it', () => {
    const err = caught([
      contribution('2019-01-15', 10_000),
      balance('2019-01-31', 10_000),
      balance('2026-07-31', 30_000),
    ]);
    expect(err.coveredFrom).toBe(EARLIEST_SUPPORTED);
    expect(err.coveredTo).toBe('2026-07-31');
    expect(err.message).toContain('can be analysed');
    // And re-running on just that portion works, which is what makes the
    // offer honest rather than decorative.
    const r = run([balance(EARLIEST_SUPPORTED, 21_000), balance('2026-07-31', 30_000)]);
    expect(r.endingValue).toBe(30_000);
  });

  it('says plainly when NONE of the history is covered', () => {
    const err = caught([
      contribution('2005-01-15', 10_000),
      balance('2005-01-31', 10_000),
      balance('2010-12-31', 18_000),
    ]);
    expect(err.code).toBe('history-before-coverage');
    expect(err.coveredFrom).toBe(null);
    expect(err.coveredTo).toBe(null);
    expect(err.message).toContain('None of this history falls inside the supported range');
  });

  it('catches the OTHER end of the window too, which no document mentions', () => {
    // The coverage table in INTERACTION.md only names a history that predates
    // the data. A history running past the last month fails identically —
    // `missing monthly GLOBAL_EQUITY 2026-08` — and will start happening to
    // ordinary users the moment the monthly refresh is a month late. Same
    // treatment, opposite direction.
    const err = caught([
      contribution('2025-01-15', 10_000),
      balance('2025-01-31', 10_000),
      balance('2026-11-30', 12_000),
    ]);
    expect(err.code).toBe('history-after-coverage');
    expect(err.latestSupported).toBe(LATEST_SUPPORTED);
    expect(err.coveredFrom).toBe('2025-01-15');
    expect(err.coveredTo).toBe(LATEST_SUPPORTED);
    expect(err.message).toContain('past the end of the benchmark data');
    expect(err.message).not.toContain('missing monthly');
  });

  it('accepts the exact boundary months at both ends', () => {
    // Off-by-one on the guard would refuse the fixture itself.
    expect(() => run([
      balance('2021-10-01', 10_000),
      balance('2026-07-31', 15_000),
    ])).not.toThrow();
    expect(() => run([
      balance('2021-10-31', 10_000),
      balance('2026-07-01', 15_000),
    ])).not.toThrow();
  });

  it('rejects a single month outside coverage at either edge', () => {
    expect(caught([balance('2021-09-30', 10_000), balance('2026-07-31', 15_000)]).code)
      .toBe('history-before-coverage');
    expect(caught([balance('2021-10-31', 10_000), balance('2026-08-01', 15_000)]).code)
      .toBe('history-after-coverage');
  });

  it('does not gate a strategy on its own inception date — a recorded gap', () => {
    // INTERACTION.md: "A selected strategy predates its fund's inception —
    // Disable it with the reason, don't hide it." SPEC.md: TARGET_2060 did
    // not exist before 2012, GLOBAL_EQUITY before 2008, and `meta.inception`
    // carries the dates. The engine reads neither `meta.inception` nor the
    // catalogue's `requiresAfter`; it computes every strategy for every input.
    //
    // Not a live defect, because every computable history today starts in
    // 2021 and every fund existed by then. It becomes one the moment the
    // monthly data is extended, which is why it is pinned next to the tests
    // that extension un-blocks.
    const r = run([balance('2021-10-31', 10_000), balance('2026-07-31', 15_000)]);
    expect(r.strategies.map((s) => s.id)).toContain('TARGET_2060');
    expect(benchmarks.meta.inception['TARGET_2060']).toBe(2012);
    expect(benchmarks.meta.inception['GLOBAL_EQUITY']).toBe(2008);
  });
});

// ═══════════════════════════════════ BLOCKED: what a long history must do

describe('long histories (BLOCKED on monthly benchmark data before 2021-10)', () => {
  /**
   * Ten years of fortnightly contributions: ~260 flows, 121 months.
   *
   * BLOCKED — starts 2016-08, and the monthly series starts 2021-10. Floor:
   * 2021-10-01. Un-skip when `benchmarkCoverage(...).firstMonth <= '2016-08'`.
   *
   * This is the shape SPEC.md's data model names outright ("someone
   * contributing every fortnight with four hundred") and the one that will
   * expose the `feeShare` bisection cost measured in synthetic.test.ts: at
   * ~260 flows it is roughly twice the 1.2s that 126 flows already costs, so
   * whoever un-skips this should expect the 4s budget below to bite.
   */
  it.skip('handles ten years of fortnightly contributions', () => {
    const flows: InputRow[] = [];
    for (let d = Date.UTC(2016, 7, 15); d <= Date.UTC(2026, 6, 31); d += 14 * 86400000) {
      flows.push(contribution(new Date(d).toISOString().slice(0, 10), 500));
    }
    const months = monthRange('2016-08', '2026-07');
    const rows = [...flows, ...months.map((mk, i) => balance(endOf(mk), 500 + i * 900))];

    const t0 = Date.now();
    const r = run(rows, { feePct: 0.0085 });
    expect(Date.now() - t0).toBeLessThan(4000);

    expect(flows.length).toBeGreaterThan(250);
    expect(r.dataQuality.flowCount).toBe(flows.length);
    expect(r.dataQuality.spanMonths).toBe(months.length);
    expect(r.dataQuality.granularity).toBe('monthly');
    expect(r.grossContributed).toBe(flows.length * 500);
    expect(Number.isFinite(r.you.xirr)).toBe(true);
    expect(Object.keys(r.you.annual)).toEqual(
      ['2016', '2017', '2018', '2019', '2020', '2021', '2022', '2023', '2024', '2025', '2026']);
    // Ten years spans 2018 and 2022, both down years, so the capture-asymmetry
    // check finally has the sample it wants.
    const ref = r.strategies.find((s) => s.id === referenceId)!;
    expect(Object.keys(r.you.annual).filter((y) => ref.annual[y] < 0).length)
      .toBeGreaterThanOrEqual(2);
  });

  /**
   * Thirty years, annual contributions and year-end balances — SPEC.md tier 1
   * at the longest span the annual data covers.
   *
   * BLOCKED — starts 1996-01, monthly series starts 2021-10. Floor:
   * 2021-10-01. Un-skip when `benchmarkCoverage(...).firstMonth <= '1996-01'`.
   *
   * If open decision 1 is resolved as option (b) — annual returns spread
   * evenly across months — this test must still pass, and `dataQuality`
   * must additionally say so somewhere, because SPEC.md requires that
   * fallback to be "labelled in the UI wherever it's in play". That label
   * does not exist yet, so there is nothing here to assert it against; the
   * assertion belongs in this test when it is written.
   */
  it.skip('handles thirty years of annual contributions', () => {
    const rows: InputRow[] = [];
    for (let y = 1996; y <= 2026; y++) {
      rows.push(contribution(`${y}-01-15`, 5_000));
      rows.push(balance(y === 2026 ? '2026-07-31' : `${y}-12-31`, 5_000 * (y - 1995) * 1.4));
    }
    const r = run(rows);
    expect(r.dataQuality.spanMonths).toBe(monthRange('1996-01', '2026-07').length);
    expect(r.dataQuality.granularity).toBe('annual');
    expect(Object.keys(r.you.annual)).toHaveLength(31);
    expect(Number.isFinite(r.you.xirr)).toBe(true);
    expect(Number.isFinite(r.capture.pctKept)).toBe(true);
    // A 30-year window contains several bear markets, so the "short sample"
    // caveat SPEC.md requires elsewhere does not apply — but the S&P 500
    // caution does, and must still be attached to that strategy.
    expect(strategies.find((s) => s.id === 'US_500')!.caution).toBeTruthy();
  });

  /**
   * BLOCKED — starts 2005-01, before both the monthly data (2021-10) and
   * GLOBAL_EQUITY's own 2008 inception. Floor: 2021-10-01.
   *
   * SPEC.md, benchmark data: "GLOBAL_EQUITY did not exist as a fund before
   * 2008. For earlier periods it must be built from US_TOTAL + INTL_TOTAL at
   * market weights and shown as constructed." Nothing in the engine does this
   * today and nothing can, because there is no pre-2008 monthly data to build
   * from. Written so the requirement is not lost with the data work.
   */
  it.skip('marks GLOBAL_EQUITY as constructed before its 2008 inception', () => {
    const r = run([
      contribution('2005-01-14', 10_000),
      balance('2005-01-31', 10_000),
      balance('2015-12-31', 25_000),
    ]);
    const ge = r.strategies.find((s) => s.id === 'GLOBAL_EQUITY')!;
    expect(Number.isFinite(ge.endingValue)).toBe(true);
    // The shape of the label is not specified anywhere, so this test asserts
    // only that ONE exists and names both components. Whoever implements it
    // should tighten this to the agreed wording.
    const label = (ge as unknown as { constructed?: string }).constructed;
    expect(label).toBeTruthy();
    expect(label).toContain('US_TOTAL');
    expect(label).toContain('INTL_TOTAL');
  });

  /**
   * BLOCKED — starts 2009-01, before TARGET_2060's 2012 inception and before
   * the monthly data. Floor: 2021-10-01.
   *
   * INTERACTION.md: "A selected strategy predates its fund's inception —
   * Disable it with the reason, don't hide it." The engine currently returns
   * a result for every strategy regardless (pinned live, above).
   */
  it.skip('disables a strategy whose fund did not exist yet, with the reason', () => {
    const rows = [
      contribution('2009-01-15', 10_000),
      balance('2009-01-31', 10_000),
      balance('2015-12-31', 20_000),
    ];
    const r = analyse({ rows, feePct: 0 }, benchmarks, strategies, referenceId, NOW);
    const t2060 = r.strategies.find((s) => s.id === 'TARGET_2060');
    expect(t2060).toBeDefined();
    const unavailable = (t2060 as unknown as { unavailable?: string }).unavailable;
    expect(unavailable, 'TARGET_2060 must be present but disabled, not omitted').toBeTruthy();
    expect(unavailable).toContain('2012');
  });
});
