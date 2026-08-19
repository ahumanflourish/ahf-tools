/**
 * `outperformed` — the finding that exists so the tool can say "you did fine".
 *
 * SPEC.md non-negotiable 3: "It must be able to say 'you did fine'. A tool
 * that always manufactures a grievance is untrustworthy. If someone beat the
 * reference, say so plainly (the `outperformed` finding exists for this). Do
 * not bury it."
 *
 * The engine's own comment on the check reads "Genuinely good result — the
 * tool must be able to say this", and until this file there was not one test
 * touching it. A non-negotiable guarded by nothing is a non-negotiable that
 * can be deleted by accident.
 */
import { describe, it, expect } from 'vitest';

import { analyse, deriveFindings } from '../src/index';
import type { AnalysisResult, Finding, PortfolioInput, StrategyResult } from '../src/index';

import fixturesJson from '../src/data/fixtures.json' with { type: 'json' };

import {
  NOW, balance, benchmarks, contribution, referenceId, run, strategies,
} from './synthetic/shapes';

const find = (r: AnalysisResult): Finding | undefined =>
  r.findings.find((f) => f.id === 'outperformed');

/**
 * A portfolio that beats every reference strategy in the catalogue: 20,000 in
 * at the start, another 10,000 later, ending at 120,000. Invented to be
 * unambiguous — no reference comes close — because a marginal win would make
 * this a test of the benchmark data rather than of the rule.
 */
const WINNER = [
  contribution('2021-10-12', 20_000),
  balance('2021-10-31', 20_000),
  balance('2022-12-31', 34_000),
  contribution('2023-06-15', 10_000),
  balance('2023-12-31', 62_000),
  balance('2024-12-31', 85_000),
  balance('2025-12-31', 108_000),
  balance('2026-07-31', 120_000),
];

describe('outperformed: the tool can say "you did fine"', () => {
  it('fires when the user finishes ahead of the reference', () => {
    const r = run(WINNER);
    expect(r.capture.forgone).toBeLessThan(0);
    expect(find(r)).toBeDefined();
  });

  it('carries the wording SPEC.md says to use verbatim', () => {
    // SPEC.md findings section: "Each carries its own explanatory `detail` —
    // use it verbatim; the wording was worked out carefully to be accurate
    // without being inflammatory." So the wording is part of the contract.
    const f = find(run(WINNER))!;
    expect(f.title).toBe('Your strategy beat the passive reference');
    expect(f.detail).toContain('Over this period you finished ahead of the reference strategy.');
    // The two hedges the copy carries: risk, and sample size.
    expect(f.detail).toContain('whether that came with more risk');
    expect(f.detail).toContain('a few years is a short sample');
  });

  it('is severity `notable`, so it cannot be rendered quietly', () => {
    // RESOLVED 2026-08-19. SPEC.md's findings section says render `notable`
    // prominently and `info` quietly; non-negotiable 3 says of this finding
    // "do not bury it". While it was `info` those two rules could not both be
    // followed. The non-negotiable won and SPEC's table was amended to match.
    //
    // `notable` is a prominence tier, not a verdict — `size-tilt` is notable
    // and passes no judgement either. A tool that renders a grievance loudly
    // and a good result quietly is not neutral; it is just slower to say the
    // kind thing.
    expect(find(run(WINNER))!.severity).toBe('notable');

    // The reason this row exists at all: on a clean win it must be the ONLY
    // finding, so there is nothing louder sitting next to it.
    expect(run(WINNER).findings.map((f) => f.id)).toEqual(['outperformed']);
  });

  it('fires whichever strategy is the reference, when the user beats them all', () => {
    // The check reads `capture.forgone`, which is measured against the
    // SELECTED reference. SPEC.md lets the user add and remove strategies, so
    // the finding has to hold for every choice, not just the default.
    for (const def of strategies) {
      const r = analyse({ rows: WINNER, feePct: 0 }, benchmarks, strategies, def.id, NOW);
      expect(r.referenceId).toBe(def.id);
      expect(r.endingValue).toBeGreaterThan(
        r.strategies.find((s) => s.id === def.id)!.endingValue);
      expect(find(r), `outperformed did not fire against ${def.id}`).toBeDefined();
    }
  });

  it('is the only finding on a clean win with no fee and no holdings', () => {
    // "Do not bury it" at its strongest: nothing else competes for attention.
    expect(run(WINNER).findings.map((f) => f.id)).toEqual(['outperformed']);
  });

  it('does NOT fire on the real fixture, which lost to the reference', () => {
    // The other half of the guard. A rule that always fires is not a rule.
    const fixture = fixturesJson as unknown as {
      input: Omit<PortfolioInput, 'holdings'>;
      holdings: NonNullable<PortfolioInput['holdings']>;
    };
    const r = analyse(
      { ...fixture.input, holdings: fixture.holdings },
      benchmarks, strategies, referenceId, NOW);
    expect(r.capture.forgone).toBeGreaterThan(0);
    expect(find(r)).toBeUndefined();
  });

  it('does not fire on a loss, however narrow', () => {
    const r = run([
      contribution('2021-10-12', 20_000),
      balance('2021-10-31', 20_000),
      balance('2026-07-31', 25_000),
    ]);
    expect(r.capture.forgone).toBeGreaterThan(0);
    expect(find(r)).toBeUndefined();
  });

  it('fires on an exact tie, and that boundary is deliberate', () => {
    // `forgone <= 0`, so a dead heat counts as "you did fine" rather than
    // falling into the gap between the two verdicts. Driven through
    // `deriveFindings` directly because an exact tie cannot be constructed
    // from balances without reverse-engineering the benchmark series.
    const flat: StrategyResult = {
      id: 'GLOBAL_EQUITY', label: 'Global stock market',
      expenseRatio: { extra: 0, embedded: null, allIn: null, source: 'catalogue' },
      endingValue: 50_000, xirr: 0.1, vsYou: 0, path: [], annual: {},
    };
    const tie = {
      available: 10_000, kept: 10_000, forgone: 0,
      pctKept: 1, pctForgone: 0, feeShare: 0, otherShare: 0,
    };
    const f = deriveFindings(
      { rows: [], feePct: 0 }, { xirr: 0.1, annual: {} }, flat, tie,
      { usEquity: 0.63, asOf: null, source: 'fallback' }, {}, NOW);
    expect(f.map((x) => x.id)).toContain('outperformed');

    // One cent the other way and it must not fire.
    const loss = { ...tie, forgone: 0.01, kept: 9_999.99, pctKept: 0.999999 };
    const g = deriveFindings(
      { rows: [], feePct: 0 }, { xirr: 0.1, annual: {} }, flat, loss,
      { usEquity: 0.63, asOf: null, source: 'fallback' }, {}, NOW);
    expect(g.map((x) => x.id)).not.toContain('outperformed');
  });

  it('never coexists with fee-minority, which requires a gap to explain', () => {
    // `fee-minority` is gated on `forgone > 0` and `outperformed` on
    // `forgone <= 0`, so the two partition the outcome. Worth pinning: a UI
    // that rendered both would be telling the user they won and explaining
    // why they lost, in the same panel.
    for (const rows of [WINNER, [
      contribution('2021-10-12', 20_000),
      balance('2021-10-31', 20_000),
      balance('2026-07-31', 25_000),
    ]]) {
      const got = run(rows, { feePct: 0.01 }).findings.map((f) => f.id);
      expect(got.includes('outperformed') && got.includes('fee-minority')).toBe(false);
    }
  });

  it('survives the lump-sum shape, where nothing was contributed', () => {
    // The two fixes meet here: a lump sum that beat the reference must still
    // be told it did. Before the no-contributions fix this input threw.
    const r = run([balance('2021-10-31', 20_000), balance('2026-07-31', 120_000)]);
    expect(r.openingPosition).toBe(20_000);
    expect(r.capture.forgone).toBeLessThan(0);
    expect(find(r)).toBeDefined();
  });
});
