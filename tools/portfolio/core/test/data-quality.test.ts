/**
 * Data-quality reporting: the granularity classification and the warnings.
 *
 * SPEC.md non-negotiable 5 — "Don't invent precision — surface
 * dataQuality.granularity and dataQuality.warnings; someone who entered five
 * numbers should be told their annual figures are rough" — is the standard
 * these assert against. The classification must not describe an input as
 * coarser or finer than it is, and anything the engine approximates must be
 * said out loud.
 */
import { describe, it, expect } from 'vitest';

import { analyse, classifyGranularity, monthRange, GRANULARITY_MAX_INTERVAL } from '../src/index';
import type {
  AnalysisResult,
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

/**
 * Pinned so the target-year finding cannot drift with the wall clock. Every
 * call in this file passes it; that it CAN be passed is the point of the
 * `now` parameter.
 */
const NOW = new Date('2026-08-18T00:00:00Z');

const run = (rows: InputRow[], extra: Partial<PortfolioInput> = {}): AnalysisResult =>
  analyse({ rows, feePct: 0, ...extra }, benchmarks, strategies, referenceId, NOW);

/** Last calendar day of a `YYYY-MM`, as ISO. */
const endOf = (mk: string): string => {
  const [y, m] = mk.split('-').map(Number);
  return new Date(Date.UTC(y, m, 0)).toISOString().slice(0, 10);
};

/**
 * The benchmark data starts 2021-10, so every synthetic case has to live
 * inside 2021-10 .. 2026-07 — the same 58-month span as the fixture, which
 * also makes the cases directly comparable with it.
 */
const SPAN = monthRange('2021-10', '2026-07');
const OPENING: InputRow = { date: '2021-10-12', type: 'contribution', amount: 10000 };

const balancesEvery = (n: number): InputRow[] => [
  OPENING,
  ...SPAN.filter((_, i) => i % n === 0).map(
    (mk): InputRow => ({ date: endOf(mk), type: 'balance', amount: 10000 }),
  ),
];

describe('granularity classification', () => {
  it('separates the inputs the old three-bucket split ran together', () => {
    // The defect: over a 58-month span the old `annual` bucket held everything
    // from 5 observations to 46, so someone with a balance every other month
    // was told their figures were annual-grade. These four must now differ.
    expect(classifyGranularity(5, 58)).toBe('annual');
    expect(classifyGranularity(27, 58)).toBe('quarterly');
    expect(classifyGranularity(46, 58)).toBe('monthly');
    expect(classifyGranularity(2, 58)).toBe('sparse');
  });

  it('classifies the four reasoned edge cases', () => {
    // 2 balances over 5 years: one observation per ~29 months.
    expect(classifyGranularity(2, 61)).toBe('sparse');
    // 8 year-end balances, first to last spanning 85 months.
    expect(classifyGranularity(8, 85)).toBe('annual');
    // 27 bi-monthly balances across the fixture's span.
    expect(classifyGranularity(27, 58)).toBe('quarterly');
    // A balance in every month.
    expect(classifyGranularity(58, 58)).toBe('monthly');
  });

  it('places the boundaries where the constants say', () => {
    // Boundaries are stated in mean months per observation, so assert on that
    // scale rather than on a count that happens to land near one.
    const at = (interval: number): ReturnType<typeof classifyGranularity> =>
      classifyGranularity(1, interval);
    const eps = 1e-9;
    expect(at(GRANULARITY_MAX_INTERVAL.monthly)).toBe('monthly');
    expect(at(GRANULARITY_MAX_INTERVAL.monthly + eps)).toBe('quarterly');
    expect(at(GRANULARITY_MAX_INTERVAL.quarterly)).toBe('quarterly');
    expect(at(GRANULARITY_MAX_INTERVAL.quarterly + eps)).toBe('annual');
    expect(at(GRANULARITY_MAX_INTERVAL.annual)).toBe('annual');
    expect(at(GRANULARITY_MAX_INTERVAL.annual + eps)).toBe('sparse');
  });

  it('is monotonic — more observations never coarsen the label', () => {
    const rank = { sparse: 0, annual: 1, quarterly: 2, monthly: 3 };
    let previous = 0;
    for (let obs = 1; obs <= 58; obs++) {
      const r = rank[classifyGranularity(obs, 58)];
      expect(r, `${obs} observations classified below ${obs - 1}`).toBeGreaterThanOrEqual(previous);
      previous = r;
    }
  });

  it('degrades safely on degenerate spans', () => {
    expect(classifyGranularity(0, 58)).toBe('sparse');
    expect(classifyGranularity(3, 0)).toBe('sparse');
  });
});

describe('fixture data quality', () => {
  const input: PortfolioInput = { ...fixture.input, holdings: fixture.holdings };
  const result = analyse(input, benchmarks, strategies, referenceId, NOW);
  const q = result.dataQuality;

  it('counts 27 balance rows across 27 distinct months', () => {
    // VISUALS.md's V1 criterion says 28 months carry observations. It is 27:
    // the fixture holds 27 balance rows, no two of them fall in the same
    // month, and the engine neither drops nor merges any. `balanceCount` and
    // `observedMonths` can legitimately differ — this asserts that here they
    // do not, which is what makes the spec figure a miscount rather than a
    // difference of definition.
    const rows = fixture.input.rows.filter((r) => r.type === 'balance');
    expect(rows).toHaveLength(27);
    expect(new Set(rows.map((r) => r.date.slice(0, 7))).size).toBe(27);
    expect(new Set(rows.map((r) => r.date)).size).toBe(27);
    expect(q.balanceCount).toBe(27);
    expect(q.observedMonths).toBe(27);
    expect(q.spanMonths).toBe(58);
  });

  it('is quarterly, not annual', () => {
    // 27 observations across 58 months is one every 2.15 months. The old
    // classifier called this `annual` — the same label it gave 5 observations.
    expect(q.granularity).toBe('quarterly');
    expect(q.coverage).toBeCloseTo(27 / 58, 12);
    expect(q.largestGapMonths).toBe(8); // 2022-01 -> 2022-09, and 2023-01 -> 2023-09
  });

  it('no longer reports an empty warnings list', () => {
    expect(q.warnings.length).toBeGreaterThan(0);
  });

  it('warns about density, and states the counts rather than a vague adjective', () => {
    const w = q.warnings[0];
    expect(w).toContain('Balances cover 27 of the 58 months in this period');
    expect(w).toContain('about one every 2 months');
    expect(w).toContain('the longest stretch without one runs 8 months');
    expect(w).toContain('Month-end balances would sharpen both');
  });

  it('warns that the first period is 61 days, not a year', () => {
    const w = q.warnings.find((x) => x.startsWith('2021 covers'));
    expect(w, `no 2021 warning in ${JSON.stringify(q.warnings)}`).toBeDefined();
    expect(w).toContain('2021 covers 61 days (2021-10-31 to 2021-12-31), not a full year');
    expect(w).toContain('not annualised');
    expect(w).toContain('If the account existed before 2021-10-31');
  });

  it('warns that the last period is 212 days, not a year', () => {
    const w = q.warnings.find((x) => x.startsWith('2026 covers'));
    expect(w, `no 2026 warning in ${JSON.stringify(q.warnings)}`).toBeDefined();
    expect(w).toContain('2026 covers 212 days (2025-12-31 to 2026-07-31), not a full year');
    expect(w).toContain('It fills in as the year completes.');
  });

  it('warns about exactly what is true and nothing else', () => {
    // Three warnings: density, and one for each of the two partial periods.
    // No unmeasured years (all six periods resolve) and no mid-month-dates
    // warning (2021-10-12 is not the 15th), so neither fires.
    expect(q.warnings).toHaveLength(3);
    expect(q.warnings.some((w) => w.includes('No year-by-year return could be measured'))).toBe(false);
    expect(q.warnings.some((w) => w.includes('dated mid-month'))).toBe(false);
  });

  it('leaves the verified maths untouched', () => {
    // The invariants. These changes are reporting only.
    expect(result.endingValue).toBe(53690.25);
    expect(result.you.xirr).toBeCloseTo(0.100544, 6);
    expect(result.strategies.find((s) => s.id === 'GLOBAL_EQUITY')!.endingValue)
      .toBeCloseTo(60328.4, 2);
    // The fixture's own stated tolerance for the capture block is 0.002.
    expect(Math.abs(result.capture.pctKept - 0.6812)).toBeLessThanOrEqual(0.002);
  });
});

describe('data quality across the input tiers', () => {
  it('tells a tier-1 entrant their year-by-year figures are rough', () => {
    // SPEC.md tier 1: year-end balances and annual contribution totals.
    const rows: InputRow[] = [
      OPENING,
      ...['2021-12-31', '2022-12-31', '2023-12-31', '2024-12-31', '2025-12-31', '2026-07-31'].map(
        (date): InputRow => ({ date, type: 'balance', amount: 10000 }),
      ),
    ];
    const q = run(rows).dataQuality;
    expect(q.granularity).toBe('annual');
    expect(q.warnings[0]).toContain('Balances cover 6 of the 58 months');
    expect(q.warnings[0]).toContain('Your year-by-year figures are the right shape but rough');
  });

  it('says nothing about density to a tier-2 entrant with a balance every month', () => {
    const q = run(balancesEvery(1)).dataQuality;
    expect(q.granularity).toBe('monthly');
    expect(q.coverage).toBe(1);
    expect(q.largestGapMonths).toBe(1);
    // The only warnings left are the two stub periods, which are a fact about
    // the calendar rather than about how much they typed.
    expect(q.warnings).toHaveLength(2);
    expect(q.warnings.every((w) => /^20\d\d covers /.test(w))).toBe(true);
  });

  it('redirects a sparse entrant to the figure that survives sparse data', () => {
    // Two balances five years apart. No calendar year has both an opening and
    // a closing balance, so `you.annual` is empty — which the user is told,
    // rather than being shown a blank section.
    const result = run([
      { date: '2021-10-31', type: 'contribution', amount: 10000 },
      { date: '2021-10-31', type: 'balance', amount: 10000 },
      { date: '2026-07-31', type: 'balance', amount: 18000 },
    ]);
    const q = result.dataQuality;
    expect(q.granularity).toBe('sparse');
    expect(Object.keys(result.periods)).toHaveLength(0);
    expect(Object.keys(result.you.annual)).toHaveLength(0);
    expect(q.warnings[0]).toContain('fewer than one a year');
    expect(q.warnings[0]).toContain('not enough to say much about any single year');
    expect(q.warnings[1]).toContain('No year-by-year return could be measured:');
    // The money-weighted return needs only dates and amounts, so it is real
    // even here, and the copy has to point at it rather than apologise.
    expect(Number.isFinite(result.you.xirr)).toBe(true);
  });

  it('names a year that produced no figure instead of dropping it silently', () => {
    // A single 2021 balance with nothing in 2020 cannot be measured, so 2021
    // never appears in `you.annual`.
    const rows: InputRow[] = [
      OPENING,
      ...['2021-12-31', '2022-12-31', '2023-12-31', '2024-12-31', '2025-12-31', '2026-07-31'].map(
        (date): InputRow => ({ date, type: 'balance', amount: 10000 }),
      ),
    ];
    const result = run(rows);
    expect(Object.keys(result.periods)).not.toContain('2021');
    const w = result.dataQuality.warnings.find((x) =>
      x.includes('No year-by-year return could be measured for'));
    expect(w).toBeDefined();
    expect(w).toContain('for 2021: that year has a single balance and none in the year before');
  });
});

describe('gaps the average hides', () => {
  it('reports a long hole even when the overall cadence is monthly', () => {
    // Dense everywhere except one year-long blind spot. Coverage is 79% and
    // the label is `monthly`, both fairly — but a whole year of the line is
    // drawn rather than observed, and that has to be said.
    const rows: InputRow[] = [
      OPENING,
      ...SPAN.filter((_, i) => i < 12 || i >= 24).map(
        (mk): InputRow => ({ date: endOf(mk), type: 'balance', amount: 10000 }),
      ),
    ];
    const q = run(rows).dataQuality;
    expect(q.granularity).toBe('monthly');
    expect(q.observedMonths).toBe(46);
    expect(q.largestGapMonths).toBe(13);
    expect(q.warnings[0]).toContain('Balances cover 46 of the 58 months in this period, but the ' +
      'longest stretch without one runs 13 months');
  });

  it('collapses many partial periods into one warning rather than flooding', () => {
    const rows: InputRow[] = [
      OPENING,
      ...SPAN.filter((_, i) => i < 12 || i >= 24).map(
        (mk): InputRow => ({ date: endOf(mk), type: 'balance', amount: 10000 }),
      ),
    ];
    const result = run(rows);
    const partials = Object.values(result.periods).filter((p) => p.partial);
    expect(partials.length).toBe(3);
    const w = result.dataQuality.warnings.find((x) => x.includes('periods cover less than'));
    expect(w).toContain('3 of the 6 periods cover less than a full year');
    expect(w).toContain('2021 (61 days)');
    expect(w).toContain('2022 (273 days)');
    expect(w).toContain('2026 (212 days)');
    // One combined line, not three separate ones.
    expect(result.dataQuality.warnings.filter((x) => /^20\d\d covers /.test(x))).toHaveLength(0);
  });

  it('does not tell a quarterly entrant to wait when the window is short at both ends', () => {
    // A balance every third month means the final period opens at 2025-10-31,
    // not at the year end — so "it fills in as the year completes" would only
    // be half the story.
    const result = run(balancesEvery(3));
    const w = result.dataQuality.warnings.find((x) => x.startsWith('2026 covers'));
    expect(w).toContain('2026 covers 273 days (2025-10-31 to 2026-07-31)');
    expect(w).toContain('A balance dated 2025-12-31 would line it up with the calendar year');
  });

  it('names the missing year end for a partial period in the middle', () => {
    // A history that stops observing after March 2024 and resumes in 2025
    // leaves 2024 short at its closing end.
    const rows: InputRow[] = [
      OPENING,
      ...['2021-12-31', '2022-12-31', '2023-12-31', '2024-03-31', '2025-12-31', '2026-07-31'].map(
        (date): InputRow => ({ date, type: 'balance', amount: 10000 }),
      ),
    ];
    const result = run(rows);
    expect(result.periods['2024'].partial).toBe(true);
    const w = result.dataQuality.warnings.find((x) => x.startsWith('2024 covers'));
    expect(w).toContain('2024 covers 91 days (2023-12-31 to 2024-03-31)');
    expect(w).toContain('A balance dated 2024-12-31 would make it a full year');
  });
});

describe('determinism', () => {
  const input: PortfolioInput = { ...fixture.input, holdings: fixture.holdings };

  it('gives the same answer for the same `now`', () => {
    const a = analyse(input, benchmarks, strategies, referenceId, NOW);
    const b = analyse(input, benchmarks, strategies, referenceId, new Date(NOW));
    expect(JSON.stringify(b)).toBe(JSON.stringify(a));
  });

  it('confines the wall-clock dependency to the target-year finding', () => {
    // `currentAge` is an age today, so the retirement age it implies moves
    // every 1 January. Everything else must be untouched by `now`.
    const a = analyse(input, benchmarks, strategies, referenceId, new Date('2026-06-01T00:00:00Z'));
    const b = analyse(input, benchmarks, strategies, referenceId, new Date('2030-06-01T00:00:00Z'));

    const title = (r: AnalysisResult): string =>
      r.findings.find((f) => f.id === 'target-year-mismatch')!.title;
    expect(title(a)).toContain('retiring at 48');
    expect(title(b)).toContain('retiring at 44');

    const strip = (r: AnalysisResult): string =>
      JSON.stringify({ ...r, findings: r.findings.filter((f) => f.id !== 'target-year-mismatch') });
    expect(strip(b)).toBe(strip(a));
  });

  it('still reads the clock when `now` is omitted, so existing callers work', () => {
    const r = analyse(input, benchmarks, strategies, referenceId);
    expect(r.endingValue).toBe(53690.25);
    expect(r.findings.some((f) => f.id === 'target-year-mismatch')).toBe(true);
  });
});
