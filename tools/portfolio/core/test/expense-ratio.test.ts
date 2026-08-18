/**
 * The reference strategies' expense ratios: the catalogue default, the user's
 * override, and what the result says about which one it used.
 *
 * WHY THIS FILE EXISTS. Every catalogue `expenseRatio` is 0, which is correct
 * — the component series are fund total returns, already net of that fund's
 * own expenses, so there is nothing further to charge. The consequence is that
 * the reference is priced at the cheapest share class we could source. 2060
 * target-date funds run from 0.08% (VTTSX, which is the series) to about 0.75%
 * for an actively managed one, and on the reference fixture that single input
 * moves the headline "you gave up $X" figure by 26% over less than five years.
 * The figures asserted below are the measurement that established that.
 */
import { describe, it, expect } from 'vitest';

import {
  AnalysisError,
  analyse,
  embeddedExpenseRatio,
  extraDrag,
  resolveExpenseRatio,
} from '../src/index';
import type {
  AnalysisResult,
  BenchmarkData,
  PortfolioInput,
  StrategyDef,
  StrategyResult,
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
const input: PortfolioInput = { ...fixture.input, holdings: fixture.holdings };

const run = (expenseRatios?: Record<string, number>): AnalysisResult =>
  analyse(expenseRatios ? { ...input, expenseRatios } : input, benchmarks, strategies, referenceId);

const pick = (r: AnalysisResult, id: string): StrategyResult =>
  r.strategies.find((s) => s.id === id)!;

const def = (id: string): StrategyDef => strategies.find((s) => s.id === id)!;

// ─────────────────────────────────────────────── the default, and provenance

describe('the catalogue value when the user supplies nothing', () => {
  it('uses it, and says it was the catalogue that supplied it', () => {
    const r = run();
    for (const s of r.strategies) {
      expect(s.expenseRatio.source, `${s.id} provenance`).toBe('catalogue');
      expect(s.expenseRatio.extra, `${s.id} extra drag`).toBe(def(s.id).expenseRatio);
    }
  });

  it('keeps every catalogue default at zero, deliberately', () => {
    // Not a style check. `expenseRatio` is drag ON TOP of the component
    // series, which is already net of the source fund's own fee; a non-zero
    // default would charge that fee twice, assert a figure nobody sourced, and
    // move a verified regression number. The fund's real cost is reported
    // separately, as `embedded`.
    for (const s of strategies) expect(s.expenseRatio, `${s.id}`).toBe(0);
  });

  it('reports the fund cost already inside the returns, and the all-in total', () => {
    const t = pick(run(), 'TARGET_2060').expenseRatio;
    expect(t.embedded).toBe(0.0008);
    expect(t.allIn).toBe(0.0008);
    expect(t.extra).toBe(0);
  });
});

describe('a user-supplied expense ratio', () => {
  it('is applied, and reported as theirs', () => {
    const er = pick(run({ TARGET_2060: 0.0042 }), 'TARGET_2060').expenseRatio;
    expect(er.source).toBe('user');
    expect(er.extra).toBe(0.0042);
    expect(er.embedded).toBe(0.0008);
    expect(er.allIn).toBeCloseTo(0.005, 12);
  });

  it('round-trips: an explicit zero is still the user’s answer, not the default', () => {
    // The two runs must agree to the cent and disagree about who said so.
    const a = pick(run(), 'TARGET_2060');
    const b = pick(run({ TARGET_2060: 0 }), 'TARGET_2060');
    expect(b.endingValue).toBe(a.endingValue);
    expect(a.expenseRatio.source).toBe('catalogue');
    expect(b.expenseRatio.source).toBe('user');
  });

  it('touches only the strategy it names', () => {
    const r = run({ TARGET_2060: 0.0067 });
    for (const s of r.strategies) {
      if (s.id === 'TARGET_2060') continue;
      expect(s.expenseRatio.source, `${s.id}`).toBe('catalogue');
      expect(s.endingValue, `${s.id}`).toBe(pick(run(), s.id).endingValue);
    }
  });

  it('accepts a negative drag, because a plan can offer a cheaper share class', () => {
    // SPEC.md non-negotiable 3: the tool must be able to say you did fine.
    // Clamping at zero would mean the reference could only ever be told it was
    // dearer than the one we sourced, never cheaper.
    const dearer = pick(run({ TARGET_2060: 0.0067 }), 'TARGET_2060').endingValue;
    const cheaper = pick(run({ TARGET_2060: -0.0003 }), 'TARGET_2060').endingValue;
    const base = pick(run(), 'TARGET_2060').endingValue;
    expect(dearer).toBeLessThan(base);
    expect(cheaper).toBeGreaterThan(base);
  });

  it('ignores a key for a strategy that is not in this run', () => {
    // A UI may hold overrides for the whole catalogue while the user has
    // selected part of it. That must not be an error.
    const subset = strategies.filter((s) => s.id === 'GLOBAL_EQUITY');
    const r = analyse(
      { ...input, expenseRatios: { TARGET_2060: 0.0067 } },
      benchmarks, subset, 'GLOBAL_EQUITY',
    );
    expect(r.strategies.map((s) => s.id)).toEqual(['GLOBAL_EQUITY']);
    expect(pick(r, 'GLOBAL_EQUITY').expenseRatio.source).toBe('catalogue');
  });
});

describe('an unusable expense ratio is refused, not quietly replaced', () => {
  // 75 for 0.75%, or 0.75 for 75 basis points, asks a different question from
  // the one a silent fallback would answer.
  for (const bad of [75, 0.75 * 100, 1, -1, NaN, Infinity]) {
    it(`refuses ${bad}`, () => {
      expect(() => run({ TARGET_2060: bad })).toThrow(AnalysisError);
      try {
        run({ TARGET_2060: bad });
      } catch (e) {
        const err = e as AnalysisError;
        expect(err.code).toBe('invalid-expense-ratio');
        expect(err.strategyId).toBe('TARGET_2060');
        expect(err.message).toContain('0.0075');
      }
    });
  }

  it('accepts the boundary values it documents', () => {
    expect(() => run({ TARGET_2060: 0.9999 })).not.toThrow();
    expect(() => run({ TARGET_2060: -0.9999 })).not.toThrow();
  });
});

// ───────────────────────────────────────────────────── the measured figures

describe('what the input is worth, on the real fixture', () => {
  /**
   * The evidence for building this at all. Same portfolio, same period, same
   * maths — only the price of the reference fund changes.
   *
   *   0.00%/yr extra (VTTSX itself)     58,459.31   gap 4,769.06
   *   0.42%/yr extra (a 0.50% plan fund) 57,677.08  gap 3,986.83
   *   0.67%/yr extra (a 0.75% plan fund) 57,215.93  gap 3,525.68
   *
   * A 26% swing in the headline figure over four years and nine months. Over a
   * thirty-year history it would dominate everything else the tool measures.
   */
  const cases: { extra: number | null; ending: number; gap: number }[] = [
    { extra: null, ending: 58459.31, gap: 4769.06 },
    { extra: 0, ending: 58459.31, gap: 4769.06 },
    { extra: 0.0042, ending: 57677.08, gap: 3986.83 },
    { extra: 0.0067, ending: 57215.93, gap: 3525.68 },
  ];

  for (const c of cases) {
    it(`extra drag ${c.extra == null ? 'default' : `${(c.extra * 100).toFixed(2)}%`} → ${c.ending}`, () => {
      const s = pick(run(c.extra == null ? undefined : { TARGET_2060: c.extra }), 'TARGET_2060');
      expect(s.endingValue).toBeCloseTo(c.ending, 2);
      expect(s.vsYou).toBeCloseTo(c.gap, 2);
    });
  }

  it('swings the gap by 26% across the range a real 401k menu spans', () => {
    const cheap = pick(run(), 'TARGET_2060').vsYou;
    const dear = pick(run({ TARGET_2060: extraDrag(def('TARGET_2060'), 0.0075) }), 'TARGET_2060');
    expect(dear.vsYou).toBeCloseTo(3525.68, 2);
    expect((cheap - dear.vsYou) / cheap).toBeGreaterThan(0.25);
  });
});

describe('the fixture is untouched by any of this', () => {
  // The port's regression figures, to full precision. Nothing added here may
  // move them: the user's own numbers do not depend on what the reference costs.
  const exact = (r: AnalysisResult): void => {
    expect(r.endingValue).toBe(53690.25);
    expect(r.you.xirr).toBe(0.10054387101873885);
  };

  it('reproduces them with no override', () => exact(run()));
  it('reproduces them with an override on the reference', () =>
    exact(run({ GLOBAL_EQUITY: 0.0067 })));
  it('reproduces them with an override on another strategy', () =>
    exact(run({ TARGET_2060: 0.0067 })));

  it('leaves the reference strategy itself untouched by default', () => {
    // Full precision, same standard as `endingValue` above: the reference and
    // the capture split must not drift by a cent either.
    expect(pick(run(), 'GLOBAL_EQUITY').endingValue).toBe(60328.401081907454);
    expect(run().capture.pctKept).toBe(0.6812932948716035);
  });
});

// ────────────────────────────────────────────────── the funds, and the maths

describe('naming the fund', () => {
  it('names a monthly fund for every series every strategy actually uses', () => {
    // The monthly series is the one the strategy maths reads, so this is the
    // fund a user is measured against and the one that must be nameable.
    for (const s of strategies) {
      for (const series of Object.keys(s.weights)) {
        const f = s.funds?.find((x) => x.series === series && x.basis === 'monthly');
        expect(f, `${s.id} has no monthly fund for ${series}`).toBeDefined();
        expect(f!.ticker, `${s.id}/${series} ticker`).toMatch(/^[A-Z]{2,5}$/);
        expect(f!.name.length, `${s.id}/${series} name`).toBeGreaterThan(0);
        expect(typeof f!.expenseRatio, `${s.id}/${series} ratio`).toBe('number');
        expect(f!.asOf, `${s.id}/${series} asOf`).toMatch(/^\d{4}-\d{2}-\d{2}$/);
      }
    }
  });

  it('states no ratio it could not source', () => {
    // The annual series uses different share classes — mutual funds, not the
    // ETFs — and their ratios were not sourced to the standard the rest of
    // this data is held to. Named, but not quantified, and the note says so.
    for (const s of strategies) {
      for (const f of s.funds ?? []) {
        if (f.expenseRatio == null) {
          expect(f.basis, `${s.id}/${f.ticker}`).toBe('annual');
          expect(f.note, `${s.id}/${f.ticker} must explain the omission`).toBeTruthy();
        }
      }
    }
  });

  it('weights the embedded ratio across a blend', () => {
    expect(embeddedExpenseRatio(def('TARGET_2060'))).toBe(0.0008);
    expect(embeddedExpenseRatio(def('GLOBAL_EQUITY'))).toBe(0.0006);
    // 80% VT at 0.06% + 20% BND at 0.03%.
    expect(embeddedExpenseRatio(def('GLOBAL_8020'))).toBeCloseTo(0.00054, 12);
    expect(embeddedExpenseRatio(def('GLOBAL_6040'))).toBeCloseTo(0.00048, 12);
  });

  it('returns null rather than a partial sum when a component is unnamed', () => {
    const half: StrategyDef = {
      ...def('GLOBAL_8020'),
      funds: def('GLOBAL_8020').funds!.filter((f) => f.series !== 'BOND_TOTAL'),
    };
    expect(embeddedExpenseRatio(half)).toBeNull();
    const r = resolveExpenseRatio(half, { GLOBAL_8020: 0.004 });
    expect(r.extra).toBe(0.004);
    expect(r.embedded).toBeNull();
    expect(r.allIn).toBeNull();
  });

  it('converts a published all-in ratio into the drag on top', () => {
    // What the UI does with "my plan's 2060 fund costs 0.75%".
    expect(extraDrag(def('TARGET_2060'), 0.0075)).toBeCloseTo(0.0067, 12);
    expect(extraDrag(def('TARGET_2060'), 0.005)).toBeCloseTo(0.0042, 12);
    expect(extraDrag(def('TARGET_2060'), 0.0008)).toBeCloseTo(0, 12);
    // Cheaper than the sourced share class is a negative number, not an error.
    expect(extraDrag(def('TARGET_2060'), 0.0005)).toBeCloseTo(-0.0003, 12);
  });
});

describe('the plan-availability caution', () => {
  const caution = def('TARGET_2060').caution!;

  it('is present, and short enough to live on screen permanently', () => {
    // SPEC.md non-negotiable 4: cautions render whenever the strategy is
    // visible and cannot be dismissed, so length is a real cost.
    expect(caution).toBeTruthy();
    expect(caution.length).toBeLessThan(260);
  });

  it('says what is narrowly true: the plan chooses the fund, not the user', () => {
    expect(caution).toContain('401k');
    expect(caution).toContain('0.08%');
    expect(caution.toLowerCase()).toContain('plan offers');
  });

  it('does not claim the reference was unavailable or that the user erred', () => {
    // VTTSX is a real fund anyone can buy in an IRA today. This is NOT the
    // S&P 500's hindsight trap and must not borrow its language.
    const lower = caution.toLowerCase();
    for (const word of ['hindsight', 'mistake', 'should have', 'could not', 'unavailable', 'context only']) {
      expect(lower, `caution must not say "${word}"`).not.toContain(word);
    }
  });

  it('leaves the hindsight cautions to the strategies that earn them', () => {
    expect(def('US_500').caution).toContain('hindsight');
    expect(def('GLOBAL_EQUITY').caution).toBeUndefined();
  });
});
