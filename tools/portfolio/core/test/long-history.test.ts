/**
 * Long histories: which are now live, and why the rest are still blocked.
 *
 * WHAT CHANGED.
 *
 * `benchmarks.json` v1.1.0 extended the monthly series backwards, but NOT
 * uniformly. SPEC.md open decision 1 is resolved for five of the seven
 * series and deliberately left alone for the other two. The actual coverage,
 * which is what every test in this file depends on, is pinned per series in
 * `SERIES_COVERAGE` below:
 *
 *   US_500, US_TOTAL, BOND_TOTAL    1996-01 .. 2026-07
 *   INTL_TOTAL                      2004-01 .. 2026-07
 *   GLOBAL_EQUITY                   2010-01 .. 2026-07
 *   TARGET_2060, CASH               2021-10 .. 2026-07   (not extended)
 *
 * `benchmarkCoverage` intersects the series a given strategy list uses, so
 * the supported window is a property of the SELECTION, not of the file:
 *
 *   whole catalogue                       1996-01 is refused; starts 2021-10
 *                                         — TARGET_2060 pins it
 *   catalogue minus TARGET_2060           starts 2010-01 — GLOBAL_EQUITY pins it
 *   US_TOTAL / US_500 / ALL_BONDS only    starts 1996-01
 *
 * WHAT THIS FILE DOES ABOUT IT.
 *
 *  - Two of the four long-history tests are now live: ten years of
 *    fortnightly flows against the global catalogue (2016-08, needs
 *    GLOBAL_EQUITY back to 2010), and thirty years of annual flows against
 *    the US-only catalogue (1996-01, needs only the three series that reach
 *    1996). A thirty-year history against the US market is a real, useful
 *    case and it works today.
 *  - Two stay `it.skip`, and NEITHER is blocked on "no data" any more. Each
 *    carries the reason it is actually blocked on, sourced to `meta.notes`.
 *  - Everything asserting behaviour outside coverage runs normally.
 *
 * WHY THE TRIPWIRE IS NOW PER SERIES.
 *
 * The old tripwire asserted ONE global first month, `benchmarkCoverage(...,
 * strategies).firstMonth === '2021-10'`, and it did not fire when the data
 * was extended — because TARGET_2060 stayed at 2021-10 and pins the
 * intersection, the catalogue-wide first month never moved even though five
 * series gained up to twenty-five years each. What actually caught the
 * extension was two incidental assertions elsewhere in this describe block.
 * So: assert the ACTUAL per-series coverage each test depends on. The next
 * extension then fails loudly, per series, and the failure message names the
 * test to revisit.
 *
 * So: a skipped test here means blocked, with the reason stated. A failing
 * test here means something is broken.
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

/**
 * First and last month of every monthly series in `benchmarks.json`.
 *
 * Not invented — read off the file, and matching `meta.coverage` exactly.
 * This is the tripwire's subject: every test below that reaches back before
 * 2021-10 does so on the strength of one or more rows of this table, and the
 * failure message for each row names what to revisit when it moves.
 */
const SERIES_COVERAGE: Record<string, { first: string; last: string; guards: string }> = {
  US_500:        { first: '1996-01', last: '2026-07', guards: 'the thirty-year US history' },
  US_TOTAL:      { first: '1996-01', last: '2026-07', guards: 'the thirty-year US history' },
  BOND_TOTAL:    { first: '1996-01', last: '2026-07', guards: 'the thirty-year US history' },
  INTL_TOTAL:    { first: '2004-01', last: '2026-07', guards: 'a constructed pre-2010 GLOBAL_EQUITY' },
  GLOBAL_EQUITY: { first: '2010-01', last: '2026-07', guards: 'the ten-year fortnightly history' },
  TARGET_2060:   { first: '2021-10', last: '2026-07', guards: 'the fund-inception gating test' },
  CASH:          { first: '2021-10', last: '2026-07', guards: 'nothing — no strategy references it' },
};

/**
 * The catalogue minus TARGET_2060 — everything whose series reach 2010-01.
 *
 * Passing a subset is not a workaround. `benchmarkCoverage` is defined on the
 * selection, and INTERACTION.md's rule for a strategy that predates its own
 * fund is "disable it with the reason, don't hide it". The engine does not do
 * that yet (pinned live, below), so a caller wanting a pre-2021 window has to
 * make the selection itself. When the engine learns to gate per strategy,
 * these two constants should collapse back into `strategies`.
 */
const GLOBAL_CATALOGUE = strategies.filter((s) => s.id !== 'TARGET_2060');

/** The three strategies whose series reach 1996-01. */
const US_CATALOGUE = strategies.filter(
  (s) => s.id === 'US_TOTAL' || s.id === 'US_500' || s.id === 'ALL_BONDS');

// ══════════════════════ the per-series coverage every test here depends on

describe('benchmark coverage', () => {
  it('TRIPWIRE: per-series monthly coverage is exactly what this file assumes', () => {
    // This test exists to fail. When the monthly data is extended again, the
    // row that moved breaks here and its message names the test to revisit.
    // Do not edit a row to make it green without going and looking at the
    // test it guards.
    expect(
      Object.keys(benchmarks.monthly).sort(),
      'A monthly series was added or removed. Add it to SERIES_COVERAGE and decide ' +
      'which long-history test it un-blocks.',
    ).toEqual(Object.keys(SERIES_COVERAGE).sort());

    for (const [id, want] of Object.entries(SERIES_COVERAGE)) {
      const keys = Object.keys(benchmarks.monthly[id]).sort();
      expect(
        { first: keys[0], last: keys[keys.length - 1] },
        `Monthly coverage of ${id} moved. It guards ${want.guards} — go and revisit it.`,
      ).toEqual({ first: want.first, last: want.last });
      // Contiguous — no interior holes, which the guard in `analyse` assumes
      // and `buildStrategySeries` would otherwise catch far too late. The
      // backfill is where a hole would come from: `meta.notes` records that
      // INTL_TOTAL 1997-2001 reconciled but was dropped rather than shipped
      // behind the 2002-2003 break, for exactly this reason.
      expect(keys, `${id} monthly has an interior hole`)
        .toEqual(monthRange(keys[0], keys[keys.length - 1]));
    }
  });

  it('TRIPWIRE: TARGET_2060 is what still pins the whole catalogue to 2021-10', () => {
    // `meta.notes`, "NOT EXTENDED": TARGET_2060 has no annual ground truth in
    // this file and no issuer calendar-year series before its 2012 inception,
    // so it could not be gated and was left alone. It is in the catalogue, so
    // it sets the intersection for anyone who selects everything.
    const cov = benchmarkCoverage(benchmarks, strategies)!;
    expect(
      cov.firstMonth,
      'TARGET_2060 was extended. The fund-inception test at the bottom of this file ' +
      'is no longer blocked on data — un-skip it.',
    ).toBe('2021-10');
    expect(cov.lastMonth).toBe(COVERAGE_LAST_MONTH);
  });

  it('TRIPWIRE: GLOBAL_EQUITY still starts 2010-01, so 2004-2009 stays unbuilt', () => {
    // `meta.notes`: the pre-2010 construction from US_TOTAL + INTL_TOTAL was
    // implemented and measured but deliberately not shipped. If GLOBAL_EQUITY
    // ever reaches earlier, that decision was revisited and so must the
    // skipped "constructed" test below.
    const cov = benchmarkCoverage(benchmarks, GLOBAL_CATALOGUE)!;
    expect(
      cov.firstMonth,
      'GLOBAL_EQUITY now reaches before 2010-01. Revisit the skipped "constructed ' +
      'pre-2008" test — and check whether the series is labelled as constructed.',
    ).toBe('2010-01');
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
    // This is now the point of the whole exercise: bonds alone reach 1996,
    // and selecting only bonds gets you 1996 even though the full catalogue
    // stops at 2021-10.
    const bondsOnly = strategies.filter((s) => s.id === 'ALL_BONDS');
    expect(benchmarkCoverage(benchmarks, bondsOnly)!.firstMonth).toBe('1996-01');
    expect(benchmarkCoverage(benchmarks, US_CATALOGUE)!.firstMonth).toBe('1996-01');
    expect(benchmarkCoverage(benchmarks, GLOBAL_CATALOGUE)!.firstMonth).toBe('2010-01');
    expect(benchmarkCoverage(benchmarks, strategies)!.firstMonth).toBe(COVERAGE_FIRST_MONTH);
  });
});

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

// ═════════════════════════ long histories: two live, two still blocked

describe('long histories', () => {
  /**
   * Ten years of fortnightly contributions: 260 flows, 120 months.
   *
   * LIVE. Starts 2016-08; the reference strategy is GLOBAL_EQUITY, which
   * reaches 2010-01, and every other series in `GLOBAL_CATALOGUE` reaches
   * 2010 or earlier. Only TARGET_2060 has to be dropped, and it is dropped
   * because the engine cannot yet gate a strategy on its own inception, not
   * because ten years is unreasonable to ask for.
   *
   * This is the shape SPEC.md's data model names outright — "someone
   * contributing every fortnight with four hundred".
   *
   * MEASURED, and the old comment here was wrong about it. It predicted the
   * `feeShare` bisection would blow a 4s budget at ~260 flows. It does not:
   * 2.6s wall clock with a 0.85% fee, against 0.5s at feePct 0, so the
   * bisection costs about 8ms per flow and the rest of the engine is
   * negligible. The budget below is deliberately loose — a timing assertion
   * that is tight enough to be a benchmark is also tight enough to be flaky
   * on a shared runner — but it is still the only guard against the
   * bisection cost going superlinear, so do not simply raise it.
   */
  it('handles ten years of fortnightly contributions', () => {
    const flows: InputRow[] = [];
    for (let d = Date.UTC(2016, 7, 15); d <= Date.UTC(2026, 6, 31); d += 14 * 86400000) {
      flows.push(contribution(new Date(d).toISOString().slice(0, 10), 500));
    }
    const months = monthRange('2016-08', '2026-07');
    const rows = [...flows, ...months.map((mk, i) => balance(endOf(mk), 500 + i * 900))];

    const t0 = Date.now();
    const r = analyse({ rows, feePct: 0.0085 }, benchmarks, GLOBAL_CATALOGUE, referenceId, NOW);
    expect(Date.now() - t0).toBeLessThan(6000);

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
    // And the whole catalogue still refuses it, for the one reason that has
    // nothing to do with the length of the history.
    const err = caught(rows);
    expect(err.code).toBe('history-before-coverage');
    expect(err.earliestSupported).toBe(EARLIEST_SUPPORTED);
  });

  /**
   * Thirty years, annual contributions and year-end balances — SPEC.md tier 1
   * at the longest span the data covers, 1996-01 to 2026-07.
   *
   * LIVE, AGAINST THE US CATALOGUE ONLY. US_500, US_TOTAL and BOND_TOTAL all
   * reach 1996-01, so US_TOTAL / US_500 / ALL_BONDS can be compared against a
   * thirty-year history. GLOBAL_EQUITY cannot: it starts 2010-01, so every
   * global strategy — and therefore the default reference — is still out of
   * reach before 2010, and the reference here is US_TOTAL. That is a real
   * narrowing of what the user is shown, not a test convenience, and the
   * assertions at the end pin it so it is not mistaken for full support.
   *
   * Open decision 1 was resolved as option (a), real monthly data, so the
   * option-(b) "annual returns spread evenly across months, labelled" branch
   * the old comment here anticipated never happened and nothing needs to
   * assert a label for it.
   */
  it('handles thirty years of annual contributions, against the US catalogue', () => {
    const rows: InputRow[] = [];
    for (let y = 1996; y <= 2026; y++) {
      rows.push(contribution(`${y}-01-15`, 5_000));
      rows.push(balance(y === 2026 ? '2026-07-31' : `${y}-12-31`, 5_000 * (y - 1995) * 1.4));
    }
    const r = analyse({ rows, feePct: 0 }, benchmarks, US_CATALOGUE, 'US_TOTAL', NOW);

    expect(r.dataQuality.spanMonths).toBe(monthRange('1996-01', '2026-07').length);
    expect(r.dataQuality.granularity).toBe('annual');
    expect(Number.isFinite(r.you.xirr)).toBe(true);
    expect(Number.isFinite(r.capture.pctKept)).toBe(true);
    for (const s of r.strategies) expect(Number.isFinite(s.endingValue)).toBe(true);

    // THIRTY periods, not thirty-one, and the old draft of this test asserted
    // thirty-one. 1996 opens with a contribution and closes with a balance,
    // and a year-by-year return needs the PREVIOUS year's closing balance to
    // measure from — 1996 has none, so it is correctly omitted rather than
    // measured against zero. `dataQuality` says so out loud, which is the
    // behaviour SPEC.md non-negotiable 5 asks for.
    expect(Object.keys(r.you.annual)).toHaveLength(30);
    expect(Object.keys(r.you.annual)[0]).toBe('1997');
    expect(r.dataQuality.warnings.some((w) => w.includes('1996'))).toBe(true);

    // A 30-year window contains several bear markets, so the "short sample"
    // caveat SPEC.md requires elsewhere does not apply. Six full down years
    // against the fixture's one.
    const ref = r.strategies.find((s) => s.id === 'US_TOTAL')!;
    const down = Object.keys(r.you.annual).filter((y) => ref.annual[y] < 0);
    expect(down).toEqual(['2000', '2001', '2002', '2008', '2018', '2022']);
    // The S&P 500 caution still applies and must still be attached.
    expect(strategies.find((s) => s.id === 'US_500')!.caution).toBeTruthy();

    // What is still NOT supported at 1996, stated as assertions so nobody
    // reads the test above as "thirty years works everywhere".
    expect(() => analyse({ rows, feePct: 0 }, benchmarks, GLOBAL_CATALOGUE, referenceId, NOW))
      .toThrowError(/earliest supported date is 2010-01-01/);
    expect(caught(rows).earliestSupported).toBe(EARLIEST_SUPPORTED);
  });

  /**
   * A RECORDED HAZARD, not a failure. The capture-asymmetry finding averages
   * per-year ratios `you.annual[y] / ref.annual[y]`, and that estimator was
   * only ever exercised on the fixture's six periods with exactly one down
   * year. Thirty years contains years where the reference return is close to
   * zero — US_TOTAL made +0.27% in 2015 and +0.98% in 2011 — and a ratio with
   * a near-zero denominator is unbounded. Those two years alone carry the
   * mean up by a factor of ~2.7, which is a property of the estimator and
   * not of the portfolio.
   *
   * Left as-is deliberately: `deriveFindings` is under fixture regression and
   * the finding did not misfire here (it needs downCap > 1 AND upCap < 1, and
   * this shape has neither). It is pinned so that whoever hardens it —
   * ratio-of-sums, or dropping years where |ref| is small — has the failing
   * case in front of them rather than having to find it again.
   */
  it('capture ratios are unstable across a 30-year window — a recorded gap', () => {
    const rows: InputRow[] = [];
    for (let y = 1996; y <= 2026; y++) {
      rows.push(contribution(`${y}-01-15`, 5_000));
      rows.push(balance(y === 2026 ? '2026-07-31' : `${y}-12-31`, 5_000 * (y - 1995) * 1.4));
    }
    const r = analyse({ rows, feePct: 0 }, benchmarks, US_CATALOGUE, 'US_TOTAL', NOW);
    const ref = r.strategies.find((s) => s.id === 'US_TOTAL')!;
    const full = Object.keys(r.you.annual).filter((y) => !r.periods[y]?.partial);

    // Two of the thirty years have a reference return under 1% in absolute
    // terms. The fixture's six-period window had none.
    const nearZero = full.filter((y) => Math.abs(ref.annual[y]) < 0.01);
    expect(nearZero).toEqual(['2011', '2015']);

    const mean = (ys: string[]) =>
      ys.reduce((s, y) => s + r.you.annual[y] / ref.annual[y], 0) / ys.length;
    const up = full.filter((y) => ref.annual[y] > 0);
    const upWithout = up.filter((y) => !nearZero.includes(y));
    // Dropping two years out of twenty-three more than halves the estimate.
    expect(mean(up)).toBeGreaterThan(2 * mean(upWithout));
    // Nothing fired, so this is a latent weakness and not a live wrong answer.
    expect(r.findings.map((f) => f.id)).not.toContain('capture-asymmetry');
  });

  /**
   * STILL SKIPPED — and NOT for want of data any more.
   *
   * `meta.notes`, "PRE-2010 GLOBAL_EQUITY IS STILL NOT IN THIS FILE, AND THE
   * CONSTRUCTION WAS TRIED": SPEC.md's rule — build it from US_TOTAL +
   * INTL_TOTAL at market weights, labelled constructed — WAS implemented and
   * measured. A dated weight reproduces real VT to an rms of 18.2bp per month
   * over 199 months, mean -0.5bp, within 95bp of the issuer annual figure
   * every year 2010-2021. The method works.
   *
   * It was not shipped because the ANCHOR cannot be sourced. The dated weight
   * is a least-squares fit to VT, so it only exists where VT exists; rolling
   * it back to 2004-01 gives a US share of 42.3% that nothing available here
   * can check, and before 2008 there is no world-equity fund to reconcile
   * against at all. Shipping it would put an uncheckable number underneath
   * the DEFAULT reference strategy.
   *
   * So the blocker is provenance, not availability, and un-skipping this
   * needs a sourced dated market-weight series — not more Yahoo data. Note
   * INTL_TOTAL itself only reaches 2004-01 (`meta.notes`, "WHY INTL_TOTAL
   * STOPS AT 2004"), so even with an anchor this test's 2005 start is the
   * earliest the construction could ever reach.
   */
  it.skip('marks GLOBAL_EQUITY as constructed before its 2008 inception', () => {
    const r = analyse({
      rows: [
        contribution('2005-01-14', 10_000),
        balance('2005-01-31', 10_000),
        balance('2015-12-31', 25_000),
      ],
      feePct: 0,
    }, benchmarks, GLOBAL_CATALOGUE, referenceId, NOW);
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
   * STILL SKIPPED — TARGET_2060 was the one series the backfill deliberately
   * did not touch.
   *
   * `meta.notes`, "NOT EXTENDED": TARGET_2060 has no annual ground truth in
   * `benchmarks.json` and no issuer calendar-year series before its 2012
   * inception, so the backfill had nothing to gate it against and left it at
   * 2021-10. That is exactly the series this test needs, and it needs it
   * BEFORE 2012 — which is before the fund existed, so no amount of data
   * work can supply it. The only way to reach the behaviour under test is for
   * the engine to read `meta.inception` / the catalogue's `requiresAfter` and
   * return a disabled entry instead of computing one; today it computes every
   * strategy for every input and `benchmarkCoverage` refuses the whole
   * history first, so the assertion below is unreachable.
   *
   * This gap got sharper, not smaller, with the extension: a 1996 history now
   * genuinely works (above), and the only thing standing between a user and
   * one is that TARGET_2060 sits in the same catalogue. Pinned live in
   * "does not gate a strategy on its own inception date", above.
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
