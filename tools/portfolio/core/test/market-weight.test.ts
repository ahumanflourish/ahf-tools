/**
 * The US market weight used by `regional-tilt` is derived, not hardcoded.
 *
 * Kept in its own file so it does not collide with the fixture regression
 * suite. What is asserted here is the arithmetic (`impliedUsMarketWeight`),
 * the resolution order inside `analyse` (user override → derived → fallback),
 * and the fact that the finding's own copy cannot contradict the figure the
 * UI is handed on `AnalysisResult`.
 */
import { describe, it, expect } from 'vitest';

import { analyse, impliedUsMarketWeight, FALLBACK_US_MARKET_WEIGHT } from '../src/index';
import type { AnalysisResult, BenchmarkData, PortfolioInput, StrategyDef } from '../src/index';

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

const baseInput: PortfolioInput = { ...fixture.input, holdings: fixture.holdings };

const run = (over: Partial<PortfolioInput> = {}): AnalysisResult =>
  analyse({ ...baseInput, ...over }, benchmarks, strategies, referenceId);

/** The fixture's holdings: 76.83% of equity is US. */
const usShare = (() => {
  const eq = fixture.holdings.positions.filter(
    (p) => p.assetClass === 'us_equity' || p.assetClass === 'intl_equity',
  );
  const total = eq.reduce((s, p) => s + p.value, 0);
  const us = eq.filter((p) => p.assetClass === 'us_equity').reduce((s, p) => s + p.value, 0);
  return us / total;
})();

describe('derived US market weight', () => {
  it('recovers the weight the benchmark series actually implies', () => {
    // Whole shipped series: 0.6126, not the 0.63 the constant claimed.
    const full = impliedUsMarketWeight(benchmarks, undefined, 600);
    expect(full).not.toBeNull();
    expect(full!.usEquity).toBeCloseTo(0.6126, 3);
    expect(full!.source).toBe('derived');
    expect(full!.months).toBe(58);
    expect(Math.abs(full!.usEquity - FALLBACK_US_MARKET_WEIGHT)).toBeGreaterThan(0.01);

    // And it is not a constant: per calendar year it moves by ~3pp across
    // five years, which is a fifth of the 15pp tilt threshold.
    const perYear: Record<string, number> = {};
    for (const [year, expected] of Object.entries({
      '2022': 0.6015,
      '2023': 0.5971,
      '2024': 0.6274,
      '2025': 0.6279,
    })) {
      const w = impliedUsMarketWeight(benchmarks, `${year}-12`, 12);
      expect(w, `no estimate for ${year}`).not.toBeNull();
      expect(w!.months).toBe(12);
      expect(w!.usEquity).toBeCloseTo(expected, 4);
      perYear[year] = w!.usEquity;
    }
    const spread = Math.max(...Object.values(perYear)) - Math.min(...Object.values(perYear));
    expect(spread).toBeGreaterThan(0.03);
  });

  it('anchors to the holdings date, and that is what makes regional-tilt fire', () => {
    const r = run();

    expect(r.marketWeight.source).toBe('derived');
    expect(r.marketWeight.asOf).toBe('2023-08'); // holdings are asOf 2023-08-31
    expect(r.marketWeight.months).toBe(23); // series starts 2021-10
    expect(r.marketWeight.usEquity).toBeCloseTo(0.5995, 3);

    // The finding fires on the derived weight (16.9pp) and would NOT have
    // fired on the old 0.63 constant (13.8pp). That difference is the whole
    // point of the change, so it is asserted rather than assumed.
    const derivedDeviation = Math.abs(usShare - r.marketWeight.usEquity);
    const constantDeviation = Math.abs(usShare - FALLBACK_US_MARKET_WEIGHT);
    expect(derivedDeviation).toBeGreaterThan(0.15);
    expect(constantDeviation).toBeLessThan(0.15);
    expect(derivedDeviation).toBeCloseTo(0.1688, 3);

    expect(r.findings.map((f) => f.id)).toContain('regional-tilt');
  });

  it('hands the UI a figure the finding copy cannot contradict', () => {
    // VISUALS.md V5 requires "market weight is ~X%" next to this finding. The
    // tile reads AnalysisResult.marketWeight; the finding rounds the same
    // number, so the two cannot disagree — and `source` lets the tile label it
    // as derived rather than presenting inference as a sourced fact.
    const r = run();
    const finding = r.findings.find((f) => f.id === 'regional-tilt');
    expect(finding).toBeDefined();
    expect(finding!.detail).toContain(`${(r.marketWeight.usEquity * 100).toFixed(0)}% US`);
    expect(finding!.detail).toContain(r.marketWeight.asOf!);
    expect(['derived', 'user', 'fallback']).toContain(r.marketWeight.source);
  });

  it('lets the user override the weight, and honours it in the check', () => {
    // Someone who holds a different, defensible view of market weight gets
    // measured against theirs. No date: we know their number, not the date
    // they meant it for.
    const agreeing = run({ usMarketWeight: 0.77 });
    expect(agreeing.marketWeight).toEqual({ usEquity: 0.77, asOf: null, source: 'user' });
    expect(agreeing.findings.map((f) => f.id)).not.toContain('regional-tilt');

    // And the override really drives the check, in both directions.
    const disagreeing = run({ usMarketWeight: 0.5 });
    expect(disagreeing.marketWeight.source).toBe('user');
    const finding = disagreeing.findings.find((f) => f.id === 'regional-tilt');
    expect(finding).toBeDefined();
    expect(finding!.detail).toContain('50% US');
    expect(finding!.detail).not.toContain('as of');
  });

  it('falls back to the constant when the data cannot support a derivation', () => {
    // Holdings dated before there is enough series to regress on: the shipped
    // data starts 2021-10, so a 2021-11 snapshot leaves two usable months.
    expect(impliedUsMarketWeight(benchmarks, '2021-11')).toBeNull();

    const r = run({ holdings: { ...fixture.holdings, asOf: '2021-11-30' } });
    expect(r.marketWeight).toEqual({
      usEquity: FALLBACK_US_MARKET_WEIGHT,
      asOf: null,
      source: 'fallback',
    });
    expect(r.marketWeight.months).toBeUndefined();

    // 76.83% vs a 63% fallback is 13.8pp, under the threshold — so the finding
    // is silent, which is the honest outcome when the weight is a guess.
    expect(r.findings.map((f) => f.id)).not.toContain('regional-tilt');
  });
});
