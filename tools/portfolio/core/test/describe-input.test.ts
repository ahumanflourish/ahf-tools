/**
 * `describeInput` — what a set of rows says about itself, with no benchmark
 * data, no strategy selection and no analysis.
 *
 * Two things are being asserted here and they pull in opposite directions.
 *
 * The first is EQUIVALENCE: for any input `analyse` accepts, `describeInput`
 * must produce byte-identically what `analyse` reports. That is the whole
 * safety property of the refactor — the review table's live note and the
 * results page's note are the same strings because they are the same code, and
 * the moment those two can differ the note stops being trustworthy.
 *
 * The second is REACH: `describeInput` must answer for inputs `analyse`
 * refuses. A table being typed into passes through two balance rows, one
 * balance row and no rows at all on its way to being complete, and a user with
 * a 1998 history is outside the benchmark window until they deselect a
 * strategy. Every one of those must return a description rather than throw —
 * that is the reason the function exists at all.
 */
import { describe, it, expect } from 'vitest';

import { analyse, describeInput } from '../src/index';
import type {
  BenchmarkData,
  InputRow,
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
};

/** Pinned so nothing here can drift with the wall clock. */
const NOW = new Date('2026-08-18T00:00:00Z');

const bal = (date: string, amount: number): InputRow => ({ date, type: 'balance', amount });
const con = (date: string, amount: number): InputRow =>
  ({ date, type: 'contribution', amount });

/**
 * The equivalence check, as one assertion.
 *
 * `analyse` is run for its side of the comparison only; every field it reports
 * under `periods` and `dataQuality` must come back from the rows alone.
 */
const agreesWithAnalyse = (rows: InputRow[], extra: Partial<PortfolioInput> = {}): void => {
  const result = analyse({ rows, feePct: 0, ...extra }, benchmarks, strategies, referenceId, NOW);
  const described = describeInput(rows);
  expect(described.periods).toEqual(result.periods);
  expect(described.dataQuality).toEqual(result.dataQuality);
  // Byte-identical, not merely deep-equal: the warning copy is prose the UI
  // renders verbatim, and key order is what the fixture's JSON snapshot pins.
  expect(JSON.stringify(described.dataQuality)).toBe(JSON.stringify(result.dataQuality));
  expect(JSON.stringify(described.periods)).toBe(JSON.stringify(result.periods));
};

describe('describeInput agrees with analyse', () => {
  it('reports exactly what analyse reports for the reference fixture', () => {
    agreesWithAnalyse(fixture.input.rows, {
      ...fixture.input,
      holdings: fixture.holdings,
    });
  });

  it('pins the fixture description on its own, with no benchmark data in sight', () => {
    const d = describeInput(fixture.input.rows);
    expect(d.dataQuality.balanceCount).toBe(27);
    expect(d.dataQuality.observedMonths).toBe(27);
    expect(d.dataQuality.spanMonths).toBe(58);
    expect(d.dataQuality.flowCount).toBe(13);
    expect(d.dataQuality.largestGapMonths).toBe(8);
    expect(d.dataQuality.granularity).toBe('quarterly');
    expect(d.dataQuality.firstDate).toBe('2021-10-12');
    expect(d.dataQuality.lastDate).toBe('2026-07-31');
    expect(d.dataQuality.balanceBeforeFirstFlow).toBeNull();
    expect(Object.keys(d.periods)).toEqual(
      ['2021', '2022', '2023', '2024', '2025', '2026']);
    expect(d.periods['2021'].partial).toBe(true);
    expect(d.periods['2022'].partial).toBe(false);
    expect(d.periods['2026'].partial).toBe(true);
    // The flow plan's standard for the live note: three paragraphs, the first
    // of them the density sentence, before anything has been analysed.
    expect(d.dataQuality.warnings).toHaveLength(3);
    expect(d.dataQuality.warnings[0]).toContain(
      'Balances cover 27 of the 58 months in this period');
  });

  it('agrees on a lump sum with no flows at all', () => {
    agreesWithAnalyse([
      bal('2021-10-31', 50_000),
      bal('2023-06-30', 60_000),
      bal('2026-07-31', 80_000),
    ]);
  });

  it('agrees when a balance predates the first contribution', () => {
    agreesWithAnalyse([
      bal('2021-10-31', 20_000),
      con('2022-03-15', 5_000),
      bal('2023-12-31', 28_000),
      bal('2026-07-31', 40_000),
    ]);
  });

  it('agrees on a year-end-only history with an unmeasurable year', () => {
    agreesWithAnalyse([
      con('2021-10-12', 10_000),
      bal('2021-12-31', 10_000),
      bal('2023-12-31', 15_000),
      bal('2024-12-31', 17_000),
      bal('2026-07-31', 22_000),
    ]);
  });

  it('agrees on a dense history with one long hole', () => {
    const rows: InputRow[] = [con('2021-10-12', 10_000)];
    const months = [
      '2021-10', '2021-11', '2021-12', '2022-01', '2022-02',
      // an eight-month hole
      '2022-10', '2022-11', '2022-12', '2023-01', '2023-02', '2023-03',
      '2023-04', '2023-05', '2023-06', '2023-07', '2023-08', '2023-09',
      '2023-10', '2023-11', '2023-12', '2024-01', '2024-02', '2024-03',
      '2024-04', '2024-05', '2024-06', '2024-07', '2024-08', '2024-09',
      '2024-10', '2024-11', '2024-12', '2025-01', '2025-02', '2025-03',
      '2025-04', '2025-05', '2025-06', '2025-07', '2025-08', '2025-09',
      '2025-10', '2025-11', '2025-12', '2026-01', '2026-02', '2026-03',
      '2026-04', '2026-05', '2026-06', '2026-07',
    ];
    let v = 10_000;
    for (const mk of months) {
      const [y, m] = mk.split('-').map(Number);
      v += 250;
      rows.push(bal(new Date(Date.UTC(y, m, 0)).toISOString().slice(0, 10), v));
    }
    expect(describeInput(rows).dataQuality.largestGapMonths).toBe(8);
    agreesWithAnalyse(rows);
  });
});

describe('describeInput answers where analyse refuses', () => {
  it('describes two balance rows — the minimum a table reaches first', () => {
    const rows = [bal('2021-10-31', 10_000), bal('2026-07-31', 25_000)];
    const d = describeInput(rows);
    expect(d.dataQuality.balanceCount).toBe(2);
    expect(d.dataQuality.observedMonths).toBe(2);
    expect(d.dataQuality.spanMonths).toBe(58);
    expect(d.dataQuality.flowCount).toBe(0);
    expect(d.dataQuality.granularity).toBe('sparse');
    expect(d.dataQuality.firstDate).toBe('2021-10-31');
    expect(d.dataQuality.lastDate).toBe('2026-07-31');
    // No calendar year holds both an opening and a closing balance, so there
    // are no periods and the copy says so rather than staying silent.
    expect(d.periods).toEqual({});
    expect(d.dataQuality.warnings.length).toBeGreaterThan(0);
    expect(d.dataQuality.warnings.some((w) => w.startsWith('Balances cover 2 of the 58 months')))
      .toBe(true);
    // And this input IS analysable, so it must also agree.
    agreesWithAnalyse(rows);
  });

  it('describes two balance rows across a 2015 start, which no strategy covers', () => {
    // The case from the brief: a history that begins long before the benchmark
    // data. `analyse` throws `history-before-coverage`; the table still has to
    // tell the user what they have typed.
    const rows = [bal('2015-01-31', 12_000), bal('2019-10-31', 30_000)];
    expect(() => analyse({ rows, feePct: 0 }, benchmarks, strategies, referenceId, NOW))
      .toThrow(/before the benchmark data begins/);

    const d = describeInput(rows);
    expect(d.dataQuality.balanceCount).toBe(2);
    expect(d.dataQuality.spanMonths).toBe(58);
    expect(d.dataQuality.firstDate).toBe('2015-01-31');
    expect(d.dataQuality.lastDate).toBe('2019-10-31');
    expect(d.dataQuality.granularity).toBe('sparse');
    expect(d.dataQuality.warnings.length).toBeGreaterThan(0);
  });

  it('describes a six-balance quarterly history that opens in 2015', () => {
    // The brief's worked example: "6 balance points across 4.8 years,
    // quarterly cadence, these three things are approximate."
    const rows = [
      bal('2015-01-31', 12_000), bal('2016-03-31', 15_000), bal('2017-06-30', 18_000),
      bal('2018-06-30', 21_000), bal('2019-06-30', 25_000), bal('2019-10-31', 30_000),
    ];
    expect(() => analyse({ rows, feePct: 0 }, benchmarks, strategies, referenceId, NOW))
      .toThrow(/before the benchmark data begins/);

    const d = describeInput(rows);
    expect(d.dataQuality.balanceCount).toBe(6);
    expect(d.dataQuality.observedMonths).toBe(6);
    expect(d.dataQuality.spanMonths).toBe(58);
    expect(d.dataQuality.granularity).toBe('annual');
    expect(Object.keys(d.periods)).toEqual(['2016', '2017', '2018', '2019']);
    expect(d.dataQuality.warnings.length).toBeGreaterThan(0);
  });

  it('describes one balance row without throwing, and stays quiet about it', () => {
    const d = describeInput([bal('2024-06-30', 10_000)]);
    expect(d.dataQuality.balanceCount).toBe(1);
    expect(d.dataQuality.observedMonths).toBe(1);
    expect(d.dataQuality.spanMonths).toBe(1);
    expect(d.dataQuality.coverage).toBe(1);
    expect(d.dataQuality.largestGapMonths).toBe(0);
    expect(d.dataQuality.firstDate).toBe('2024-06-30');
    expect(d.dataQuality.lastDate).toBe('2024-06-30');
    expect(d.periods).toEqual({});
    // Below two balances there is no measurable history, so every warning in
    // the list would be a complaint about a row still being typed.
    expect(d.dataQuality.warnings).toEqual([]);
  });

  it('describes zero rows without throwing', () => {
    const d = describeInput([]);
    expect(d.dataQuality).toEqual({
      balanceCount: 0,
      observedMonths: 0,
      spanMonths: 0,
      coverage: 0,
      largestGapMonths: 0,
      flowCount: 0,
      balanceBeforeFirstFlow: null,
      granularity: 'sparse',
      firstDate: null,
      lastDate: null,
      warnings: [],
    });
    expect(d.periods).toEqual({});
  });

  it('describes flows typed before any balance', () => {
    const d = describeInput([con('2024-01-15', 500), con('2024-07-15', 500)]);
    expect(d.dataQuality.flowCount).toBe(2);
    expect(d.dataQuality.balanceCount).toBe(0);
    expect(d.dataQuality.firstDate).toBe('2024-01-15');
    expect(d.dataQuality.lastDate).toBe('2024-07-15');
    expect(d.dataQuality.warnings).toEqual([]);
  });

  it('describes a history with both a partial first and a partial last period', () => {
    // Year-end balances with a stub at each end — the fixture's own shape, at
    // a tenth the size. Both stubs must be named, and each gets its own
    // remedy: an earlier balance for the opening one, patience for the closing
    // one, which is short only because the year is still running.
    const rows = [
      con('2021-10-12', 10_000),
      bal('2021-10-31', 10_000),
      bal('2021-12-31', 10_400),
      bal('2022-12-31', 14_000),
      bal('2023-12-31', 17_000),
      bal('2024-12-31', 20_000),
      bal('2025-12-31', 23_000),
      bal('2026-07-31', 25_000),
    ];
    const d = describeInput(rows);
    const years = Object.keys(d.periods);
    expect(years).toEqual(['2021', '2022', '2023', '2024', '2025', '2026']);
    expect(d.periods['2021']).toEqual(
      { start: '2021-10-31', end: '2021-12-31', days: 61, partial: true });
    expect(d.periods['2026']).toEqual(
      { start: '2025-12-31', end: '2026-07-31', days: 212, partial: true });
    expect(years.slice(1, -1).every((y) => !d.periods[y].partial)).toBe(true);

    const warnings = d.dataQuality.warnings;
    expect(warnings.some((w) =>
      w.startsWith('2021 covers 61 days (2021-10-31 to 2021-12-31), not a full year.') &&
      w.includes('If the account existed before 2021-10-31, adding an earlier balance'),
    )).toBe(true);
    expect(warnings.some((w) =>
      w.startsWith('2026 covers 212 days (2025-12-31 to 2026-07-31), not a full year.') &&
      w.endsWith('It fills in as the year completes.'),
    )).toBe(true);
    agreesWithAnalyse(rows);
  });

  it('names the missing year end when the last period does not open at one', () => {
    // The other branch of the closing-stub copy: waiting will not fix a period
    // that is short at its OPENING end, so the remedy has to name the date.
    const rows = [
      bal('2022-12-31', 14_000),
      bal('2023-12-31', 17_000),
      bal('2024-12-31', 20_000),
      bal('2025-03-31', 21_000),
      bal('2026-07-31', 25_000),
    ];
    const d = describeInput(rows);
    expect(d.periods['2026']).toEqual(
      { start: '2025-03-31', end: '2026-07-31', days: 487, partial: false });
    expect(d.periods['2025']).toEqual(
      { start: '2024-12-31', end: '2025-03-31', days: 90, partial: true });
    expect(d.dataQuality.warnings.some((w) =>
      w.startsWith('2025 covers 90 days') &&
      w.includes('A balance dated 2025-12-31 would make it a full year.'),
    )).toBe(true);
    agreesWithAnalyse(rows);
  });

  it('does not throw on a half-typed or impossible date', () => {
    // The table calls this on every keystroke, so `2024-1` and `2024-02-30`
    // are ordinary intermediate states rather than bugs. They are skipped;
    // saying what is wrong with them is the table's own validation.
    const d = describeInput([
      bal('2024-1', 1_000),
      bal('2024-02-30', 1_000),
      bal('2021-10-31', 10_000),
      bal('2026-07-31', 25_000),
    ] as InputRow[]);
    expect(d.dataQuality.balanceCount).toBe(2);
    expect(d.dataQuality.firstDate).toBe('2021-10-31');
    expect(d.dataQuality.lastDate).toBe('2026-07-31');
  });

  it('is pure — it neither mutates nor reorders the caller’s rows', () => {
    const rows: InputRow[] = [
      bal('2026-07-31', 25_000),
      con('2021-10-12', 10_000),
      bal('2021-10-31', 10_000),
    ];
    const snapshot = JSON.stringify(rows);
    const a = describeInput(rows);
    const b = describeInput(rows);
    expect(JSON.stringify(rows)).toBe(snapshot);
    expect(JSON.stringify(a)).toBe(JSON.stringify(b));
    // Row order is not input: the same rows shuffled describe identically.
    expect(JSON.stringify(describeInput([...rows].reverse()))).toBe(JSON.stringify(a));
  });
});
