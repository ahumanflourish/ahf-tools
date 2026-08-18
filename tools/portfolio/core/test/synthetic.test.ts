/**
 * Synthetic portfolio shapes.
 *
 * The existing suite is 44 green tests against ONE portfolio. This one covers
 * the shapes that portfolio does not have: no contributions at all, a decline,
 * a full withdrawal, hundreds of flows, the two-balance floor and the inputs
 * below it, an internal transfer, a single year, and a balance dated before
 * the first contribution.
 *
 * Each block names the SPEC.md or INTERACTION.md line it is asserting. Where
 * the documents are silent the comment says JUDGEMENT and states the reasoning
 * — those assertions pin current behaviour so a change to it is deliberate,
 * they are not claims that the documents required it.
 *
 * Nothing here touches `fixtures.json`.
 */
import { describe, it, expect } from 'vitest';

import { AnalysisError, analyse, findFlowFreeWindows, modifiedDietz, toDate } from '../src/index';
import type { InputRow, PortfolioInput } from '../src/index';

import fixturesJson from '../src/data/fixtures.json' with { type: 'json' };

import {
  COVERED_MONTHS, NOW, balance, benchmarks, contribution, days, endOf, lumpSumForward,
  referenceId, run, strategies, twoFlowXirr, withdrawal, yearEndPath,
} from './synthetic/shapes';

/** Declared locally so the package needs no @types/node to time a call. */
declare const console: { log(...args: unknown[]): void };

const ref = (r: ReturnType<typeof run>) => r.strategies.find((s) => s.id === referenceId)!;
const ids = (r: ReturnType<typeof run>) => r.findings.map((f) => f.id).sort();

// ═══════════════════════════════════════════════ 1. lump sum, no contributions

describe('shape: lump sum, no contributions ever', () => {
  // INTERACTION.md, error table: "No contributions — Fine, treat as a lump sum
  // already invested at the first balance."
  //
  // Someone who inherited a portfolio, or rolled one over and never added to
  // it. Before the fix this threw `Need at least one contribution and one
  // balance.` — the tool refused the exact case the table says must work.
  const OPEN = 100_000;
  const rows: InputRow[] = [
    balance('2021-10-31', OPEN),
    balance('2021-12-31', 103_000),
    balance('2022-12-31', 86_000),
    balance('2023-12-31', 104_000),
    balance('2024-12-31', 121_000),
    balance('2025-12-31', 138_000),
    balance('2026-07-31', 150_000),
  ];

  it('computes instead of throwing', () => {
    expect(() => run(rows)).not.toThrow();
  });

  it('treats the first balance as an opening position, not as a contribution', () => {
    const r = run(rows);
    expect(r.openingPosition).toBe(OPEN);
    // The distinction the fix turns on. Nothing was contributed, and every
    // figure that reports what the user put in must keep saying zero — a
    // synthetic contribution would have made these read 100000.
    expect(r.grossContributed).toBe(0);
    // `=== 0` rather than `toBe(0)`: negating a reduce over an empty list
    // yields `-0`, which `Object.is` distinguishes and nothing else does.
    expect(r.grossWithdrawn === 0).toBe(true);
    expect(r.netContributed).toBe(0);
    expect(r.dataQuality.flowCount).toBe(0);
  });

  it('measures the money-weighted return over the opening value', () => {
    const r = run(rows);
    // Independent: with one in and one out, XIRR has a closed form.
    const expected = twoFlowXirr('2021-10-31', '2026-07-31', OPEN, 150_000);
    expect(r.you.xirr).toBeCloseTo(expected, 9);
    expect(expected).toBeCloseTo(0.0890968, 6); // 150000/100000 over 4.75 years
  });

  it('keeps the capture framing coherent with nothing contributed', () => {
    const r = run(rows);
    // netContributed is 0, so `available = ref.endingValue - netContributed`
    // would have made the WHOLE reference ending value "available gain" and
    // the whole of the user's ending value "kept" — a capture percentage that
    // is really just the ratio of two ending values and says nothing about
    // performance. The base is invested capital, which here is the lump.
    expect(r.capture.available).toBeCloseTo(ref(r).endingValue - OPEN, 6);
    expect(r.capture.kept).toBeCloseTo(150_000 - OPEN, 6);
    expect(r.capture.forgone).toBeCloseTo(ref(r).endingValue - 150_000, 6);
    expect(r.gain).toBe(50_000);
    // And it is a real percentage, not a number over 1.
    expect(r.capture.pctKept).toBeGreaterThan(0);
    expect(r.capture.pctKept).toBeLessThan(1);
    expect(r.capture.pctKept).toBeCloseTo(r.capture.kept / r.capture.available, 12);
  });

  it('funds the reference with the same money on the same day', () => {
    const r = run(rows);
    const def = strategies.find((s) => s.id === 'GLOBAL_EQUITY')!;
    // Preconditions for the independent path in `lumpSumForward`.
    expect(def.rebalance).toBe('never');
    expect(def.expenseRatio).toBe(0);
    expect(Object.keys(def.weights)).toEqual(['GLOBAL_EQUITY']);
    // Compounded straight off benchmarks.json, touching neither
    // buildStrategySeries nor replay.
    expect(ref(r).endingValue).toBeCloseTo(
      lumpSumForward('GLOBAL_EQUITY', OPEN, COVERED_MONTHS), 6);
  });

  it('says out loud that it made the lump-sum assumption', () => {
    // SPEC.md non-negotiable 5. The user never stated this assumption; the
    // engine made it for them, so it has to be visible enough to disagree with.
    const w = run(rows).dataQuality.warnings.find((x) => x.startsWith('No contributions'));
    expect(w).toBeDefined();
    expect(w).toContain('dated 2021-10-31, is treated as money already invested');
    expect(w).toContain('each reference strategy is given the same amount on the same day');
    expect(w).toContain('figures expressed as a share of contributions do not apply');
  });

  it('reports the whole span as flow-free, because it is', () => {
    const r = run(rows);
    // With no flows every Modified Dietz figure is EXACT rather than
    // approximated, which is the one thing this shape has going for it.
    const whole = r.flowFreeWindows.find(
      (w) => w.start === '2021-10-31' && w.end === '2026-07-31');
    expect(whole).toBeDefined();
    expect(whole!.yourReturn).toBeCloseTo(150_000 / OPEN - 1, 12);
    for (const [year, p] of Object.entries(r.periods)) {
      const opening = rows.find((x) => x.date === p.start)!.amount;
      const closing = rows.find((x) => x.date === p.end)!.amount;
      expect(r.you.annual[year]).toBeCloseTo(
        modifiedDietz(opening, closing, [], toDate(p.start), toDate(p.end)), 12);
      expect(r.you.annual[year]).toBeCloseTo(closing / opening - 1, 12);
    }
  });

  it('still lets every finding that can apply apply', () => {
    // Asked directly because the brief anticipated the opposite: that with
    // nothing contributed some findings would have to be suppressed. With the
    // capture base anchored on invested capital rather than on contributions,
    // none of them do — `outperformed` and `fee-minority` both read
    // `capture.forgone`, which is `ref.endingValue - endingValue` either way,
    // and the tilt checks read holdings. This shape underperforms and pays a
    // fee, so `fee-minority` is the one that should fire.
    const r = run(rows, { feePct: 0.01 });
    expect(r.capture.forgone).toBeGreaterThan(0);
    expect(ids(r)).toContain('fee-minority');
    expect(ids(r)).not.toContain('outperformed');
    // And the fee split still adds up, which it cannot if the bisection that
    // computes `feeShare` was left running on the empty flow list.
    expect(r.capture.feeShare).toBeGreaterThan(0);
    expect(r.capture.feeShare + r.capture.otherShare).toBeCloseTo(r.capture.forgone, 6);
  });

  it('works at the two-balance floor with no flows at all', () => {
    // SPEC.md's data model floor and INTERACTION.md's minimum, combined with
    // this shape: two numbers and nothing else is a valid analysis.
    const r = run([balance('2021-10-31', OPEN), balance('2026-07-31', 150_000)]);
    expect(r.openingPosition).toBe(OPEN);
    expect(r.you.xirr).toBeCloseTo(twoFlowXirr('2021-10-31', '2026-07-31', OPEN, 150_000), 9);
    // No calendar year holds both an opening and a closing balance, so there
    // is no year-by-year series — and the user is told so rather than shown a
    // blank section.
    expect(Object.keys(r.you.annual)).toHaveLength(0);
    expect(r.dataQuality.granularity).toBe('sparse');
    expect(r.dataQuality.warnings.some((w) =>
      w.startsWith('No year-by-year return could be measured:'))).toBe(true);
  });

  it('refuses a zero opening balance rather than dividing by it', () => {
    // JUDGEMENT — no document covers this. An input with no flows and a first
    // balance of 0 describes an account that was empty and then grew, which
    // cannot have happened; there is no invested capital for a return to be a
    // return ON. Failing with a named reason beats returning NaN.
    let err: AnalysisError | undefined;
    try {
      run([balance('2021-10-31', 0), balance('2026-07-31', 150_000)]);
    } catch (e) { err = e as AnalysisError; }
    expect(err).toBeInstanceOf(AnalysisError);
    expect(err!.code).toBe('no-invested-capital');
    expect(err!.message).toContain('no invested capital');
  });
});

// ═══════════════════════════════════════════════════════ 2. losing portfolios

describe('shape: the portfolio declines', () => {
  // Nothing in either document says what a loss should produce, beyond
  // SPEC.md non-negotiable 3's converse: the tool may say "you did fine", so
  // it must equally be able to say the plain opposite without breaking.
  const rows = yearEndPath(100_000, -0.06); // ~-6%/yr from 100k

  it('reports a negative return and a negative share kept', () => {
    const r = run(rows);
    expect(r.endingValue).toBeLessThan(100_000);
    expect(r.you.xirr).toBeLessThan(0);
    expect(r.you.xirr).toBeCloseTo(twoFlowXirr('2021-10-31', '2026-07-31', 100_000, r.endingValue), 9);
    expect(r.gain).toBeLessThan(0);
    // The reference gained over this window, so `available` is positive and
    // `kept` is negative: the share kept is below zero, not clamped to it.
    expect(r.capture.available).toBeGreaterThan(0);
    expect(r.capture.kept).toBeLessThan(0);
    expect(r.capture.pctKept).toBeLessThan(0);
    expect(r.capture.pctKept + r.capture.pctForgone).toBeCloseTo(1, 12);
    expect(ids(r)).not.toContain('outperformed');
  });

  it('ends below total contributions without misreporting them', () => {
    // The other half of the shape: someone who kept paying in and still
    // finished behind what they paid in. `netContributed` and `gain` have to
    // stay honest about which is which.
    // 20,000 in at the start and 10,000 a year after, against a balance that
    // never keeps up: 60,000 contributed, 45,000 left.
    const rows2: InputRow[] = [
      contribution('2021-10-12', 20_000), balance('2021-10-31', 20_000),
      contribution('2022-06-12', 10_000), balance('2022-12-31', 27_000),
      contribution('2023-06-12', 10_000), balance('2023-12-31', 33_000),
      contribution('2024-06-12', 10_000), balance('2024-12-31', 39_000),
      contribution('2025-06-12', 10_000), balance('2025-12-31', 46_000),
      balance('2026-07-31', 45_000),
    ];
    const r = run(rows2);
    expect(r.grossContributed).toBe(60_000);
    expect(r.netContributed).toBe(60_000);
    expect(r.endingValue).toBe(45_000);
    expect(r.gain).toBe(-15_000);
    expect(r.capture.kept).toBe(-15_000);
    expect(r.you.xirr).toBeLessThan(0);
    expect(ids(r)).not.toContain('outperformed');
  });

  it('returns NaN for the share kept when the reference also lost money', () => {
    // JUDGEMENT, and a gap worth naming. Over 2021-10 → 2022-12 the reference
    // fell, so `available` is negative: there was no gain available to capture
    // and "what share of it did you keep" has no answer. The engine returns
    // NaN, which is more honest than a percentage of a negative — but no
    // document says what the UI should render for it, and NaN reaches the UI
    // unlabelled. Pinned here so the gap is visible rather than discovered.
    const r = run([
      balance('2021-10-31', 100_000),
      balance('2022-12-31', 92_000),
    ]);
    expect(r.capture.available).toBeLessThan(0);
    expect(Number.isNaN(r.capture.pctKept)).toBe(true);
    expect(Number.isNaN(r.capture.pctForgone)).toBe(true);
    // The dollar figures remain meaningful even where the percentages do not,
    // so a UI has something to fall back on.
    expect(Number.isFinite(r.capture.forgone)).toBe(true);
    expect(r.capture.forgone).toBeCloseTo(ref(r).endingValue - 92_000, 6);
  });
});

// ══════════════════════════════════════════════════ 3. hundreds of flows

describe('shape: fortnightly contributor', () => {
  // SPEC.md data model: "This deliberately handles both a lump-sum investor
  // with four data points and someone contributing every fortnight with four
  // hundred." The fixture has 15 flows; this has ten times that.
  const flows: InputRow[] = [];
  for (let d = Date.UTC(2021, 9, 15); d <= Date.UTC(2026, 6, 31); d += 14 * 86400000) {
    flows.push(contribution(new Date(d).toISOString().slice(0, 10), 500));
  }
  const balances = COVERED_MONTHS.map((mk, i) => balance(endOf(mk), 500 + i * 1_100));
  const rows = [...flows, ...balances];

  it('has the flow count this shape is about', () => {
    expect(flows.length).toBeGreaterThan(120);
  });

  it('computes, and computes quickly enough to run in a browser', () => {
    // JUDGEMENT — no document states a performance budget. 2s is chosen as
    // roughly the point at which a client-side tool feels broken; the actual
    // figures are printed so a regression is visible in the run log even when
    // it stays under the bar.
    //
    // Both are timed because the difference between them is the finding. With
    // no fee this is ~75ms; with a fee it is ~1.2s, and all of the difference
    // is the `feeShare` bisection in `analyse`, which runs 200 outer steps and
    // solves a fresh 500-step XIRR bisection inside each. That is 100,000
    // NPV evaluations over every flow the user has, and it grows LINEARLY
    // with flow count — so this shape at 126 flows sits within the budget and
    // the 10-year version of it (see long-history.test.ts) would not. Left
    // alone here because changing the iteration counts moves `feeShare`, and
    // `feeShare` is under regression test against the real fixture.
    const timed = (feePct: number): number => {
      const t0 = Date.now();
      const out = run(rows, { feePct });
      const ms = Date.now() - t0;
      console.log(`fortnightly: ${flows.length} flows x ${strategies.length} ` +
        `strategies, feePct ${feePct} — ${ms}ms`);
      expect(Number.isFinite(out.you.xirr)).toBe(true);
      expect(out.dataQuality.flowCount).toBe(flows.length);
      expect(out.grossContributed).toBe(flows.length * 500);
      return ms;
    };
    expect(timed(0)).toBeLessThan(2000);
    expect(timed(0.0085)).toBeLessThan(2000);
  });

  it('has no flow-free windows, and monthly balances instead', () => {
    // engine.ts findFlowFreeWindows: "someone contributing every fortnight
    // will have none, which is fine — their monthly balances give a good
    // Dietz series instead." Asserted rather than assumed.
    const r = run(rows);
    expect(r.flowFreeWindows).toHaveLength(0);
    expect(r.dataQuality.granularity).toBe('monthly');
    expect(Object.keys(r.you.annual)).toEqual(['2021', '2022', '2023', '2024', '2025', '2026']);
  });

  it('says nothing about density, because there is nothing to say', () => {
    // SPEC.md non-negotiable 5 cuts both ways: a warning that fires on data
    // this dense would be noise, and noise is how real warnings get ignored.
    const w = run(rows).dataQuality.warnings;
    expect(w.some((x) => x.startsWith('Balances cover'))).toBe(false);
  });
});

// ═══════════════════════════════════ 4. the floor, and the inputs beneath it

describe('shape: at and below the two-balance floor', () => {
  // INTERACTION.md, error table: "Fewer than 2 balance rows — Can't compute.
  // Explain the minimum: one starting and one ending value."
  const catchError = (rows: InputRow[]): AnalysisError => {
    try { run(rows); } catch (e) { return e as AnalysisError; }
    throw new Error('expected analyse to throw');
  };

  it('computes on exactly two balances with a flow', () => {
    const r = run([
      contribution('2021-10-12', 10_000),
      balance('2021-10-31', 10_000),
      balance('2026-07-31', 18_000),
    ]);
    expect(r.endingValue).toBe(18_000);
    expect(r.dataQuality.balanceCount).toBe(2);
    expect(Number.isFinite(r.you.xirr)).toBe(true);
  });

  it('refuses one balance instead of computing on it', () => {
    // Before the fix this SUCCEEDED: one balance, no periods, and a capture
    // percentage derived from a single point. Silently answering a question
    // the data cannot support is the failure mode the tool exists to expose.
    const err = catchError([contribution('2021-10-12', 10_000), balance('2026-07-31', 15_000)]);
    expect(err).toBeInstanceOf(AnalysisError);
    expect(err.code).toBe('insufficient-balances');
    expect(err.balanceCount).toBe(1);
    expect(err.message).toContain('2026-07-31');
    expect(err.message).toContain('one starting value and one ending value');
  });

  it('refuses zero balances and names the same minimum', () => {
    const err = catchError([contribution('2021-10-12', 10_000)]);
    expect(err.code).toBe('insufficient-balances');
    expect(err.balanceCount).toBe(0);
    expect(err.message).toContain('one starting value and one ending value');
  });

  it('refuses an entirely empty input without crashing', () => {
    const err = catchError([]);
    expect(err.code).toBe('insufficient-balances');
    expect(err.balanceCount).toBe(0);
  });

  it('fails catchably, with a name and a code rather than a message to match on', () => {
    // The whole point of a typed error: INTERACTION.md wants "specific copy
    // saying what to fix" per condition, which a UI can only select on if the
    // condition is machine-readable.
    const err = catchError([balance('2026-07-31', 15_000)]);
    expect(err).toBeInstanceOf(Error);
    expect(err.name).toBe('AnalysisError');
    expect(typeof err.code).toBe('string');
  });
});

// ══════════════════════════════════════════════════════════ 5. withdrawals

describe('shape: withdrawals', () => {
  it('handles a large withdrawal that takes the balance near zero', () => {
    const rows: InputRow[] = [
      contribution('2021-10-12', 100_000),
      balance('2021-10-31', 100_000),
      balance('2023-12-31', 118_000),
      withdrawal('2024-02-15', 115_000),
      balance('2024-12-31', 3_400),
      balance('2026-07-31', 4_100),
    ];
    const r = run(rows);
    expect(r.grossWithdrawn).toBe(115_000);
    expect(r.netContributed).toBe(-15_000);
    expect(Number.isFinite(r.you.xirr)).toBe(true);
    // Withdrawing more than was contributed makes netContributed negative, so
    // `kept = endingValue - netContributed` exceeds the ending value. That is
    // correct — the money taken out is money kept — and it is worth pinning,
    // because it is the step where a naive reading of the capture bar breaks.
    expect(r.capture.kept).toBe(4_100 + 15_000);
    expect(r.capture.available).toBeCloseTo(ref(r).endingValue + 15_000, 6);
  });

  it('handles a full withdrawal to exactly zero', () => {
    const rows: InputRow[] = [
      contribution('2021-10-12', 10_000),
      balance('2021-10-31', 10_000),
      balance('2023-12-31', 12_400),
      withdrawal('2024-02-15', 12_400),
      balance('2024-12-31', 0),
      balance('2025-12-31', 0),
      balance('2026-07-31', 0),
    ];
    const r = run(rows);
    expect(r.endingValue).toBe(0);
    expect(r.grossWithdrawn).toBe(12_400);
    expect(r.netContributed).toBe(-2_400);
    expect(r.gain).toBe(2_400);
    // A closed account still has a money-weighted return: 10,000 in, 12,400
    // out, nothing left.
    expect(r.you.xirr).toBeCloseTo(twoFlowXirr('2021-10-12', '2024-02-15', 10_000, 12_400), 4);
    // A zero balance divided into is the crash risk here. Dietz returns NaN
    // for a period opening at zero rather than throwing or returning Infinity.
    expect(r.you.annual['2025']).toBeNaN();
    expect(Number.isFinite(r.you.annual['2024'])).toBe(true);
  });

  it('lets the reference go negative when a withdrawal outruns it', () => {
    // JUDGEMENT, and a modelling artefact worth naming rather than fixing
    // here — `replay` has no floor at zero, so a withdrawal larger than the
    // reference's balance at that moment leaves it negative and compounding.
    // It is arguably the right answer (the reference could not have funded
    // the withdrawal) but it produces a NEGATIVE reference ending value, which
    // no chart is expecting. Fixing it is a maths change and out of scope.
    const r = run([
      contribution('2021-10-12', 10_000),
      balance('2021-10-31', 10_000),
      balance('2024-06-30', 14_000),
      withdrawal('2024-07-15', 14_000),
      balance('2026-07-31', 0),
    ]);
    expect(ref(r).endingValue).toBeLessThan(0);
    // And it flips the verdict: `forgone` goes negative, so the tool reports
    // an outperformance. Defensible — the user really did extract more than
    // the reference could have — but it rests on a negative balance.
    expect(r.capture.forgone).toBeLessThan(0);
    expect(ids(r)).toContain('outperformed');
  });
});

// ═══════════════════════════════════════════════════ 6. internal transfers

describe('shape: internal transfer, equal and opposite within 7 days', () => {
  // INTERACTION.md, review table: "If two flows of equal magnitude and
  // opposite sign fall within ~7 days, surface them together and ask whether
  // they were an internal transfer. This caught a $11,375 misstatement."
  //
  // That detection is specified for the review table, which is UI. The engine
  // has no such helper — asserted below — so what matters here is what the
  // engine does with the pair if the UI never asks: whether keeping it and
  // removing it give the same answer.
  const base: InputRow[] = [
    contribution('2021-10-12', 20_000),
    balance('2021-10-31', 20_000),
    balance('2022-12-31', 21_000),
    balance('2023-12-31', 26_000),
    balance('2024-12-31', 31_000),
    balance('2025-12-31', 36_000),
    balance('2026-07-31', 39_000),
  ];
  const PAIR = 11_375;

  it('is unaffected when the pair falls inside one month', () => {
    const withPair = [...base,
      contribution('2023-03-06', PAIR), withdrawal('2023-03-10', PAIR)];
    const a = run(base);
    const b = run(withPair);
    expect(b.netContributed).toBe(a.netContributed);
    expect(b.endingValue).toBe(a.endingValue);
    // `replay` nets flows within a calendar month before applying them, so a
    // same-month pair cancels exactly and the reference is untouched.
    expect(ref(b).endingValue).toBeCloseTo(ref(a).endingValue, 9);
    // XIRR discounts the two legs at slightly different dates, so it does move
    // — by 1.7 basis points on an 11,375 four-day round trip, against a 7.2%
    // return. Small, but not nothing, and it is the smaller of the two errors
    // this pair can cause; see the straddling case below.
    expect(Math.abs(b.you.xirr - a.you.xirr)).toBeLessThan(0.0002);
    expect(Math.abs(b.you.xirr - a.you.xirr)).toBeGreaterThan(0.0001);
  });

  it('DOES distort the reference when the pair straddles a month boundary', () => {
    // The case for detecting transfers in code rather than trusting the maths
    // to absorb them. Four days apart, either side of 31 March: `replay` gives
    // the reference a full month of return on 11,375 that was never invested.
    const straddling = [...base,
      contribution('2023-03-29', PAIR), withdrawal('2023-04-03', PAIR)];
    const a = run(base);
    const b = run(straddling);
    expect(b.netContributed).toBe(a.netContributed);
    expect(b.endingValue).toBe(a.endingValue);
    const drift = ref(b).endingValue - ref(a).endingValue;
    expect(Math.abs(drift)).toBeGreaterThan(50);
    console.log(`straddling transfer moves the reference by ${drift.toFixed(2)}`);
    // Which moves the headline capture figure the whole tool is built around.
    expect(Math.abs(b.capture.pctKept - a.capture.pctKept)).toBeGreaterThan(0.001);
  });

  it('offers no transfer detection of its own — this is a UI-layer gap', () => {
    // Asserted so it is a recorded absence rather than an oversight. Nothing
    // in `dataQuality` mentions the pair; the review table must find it.
    const withPair = [...base,
      contribution('2023-03-06', PAIR), withdrawal('2023-03-10', PAIR)];
    const r = run(withPair);
    expect(r.dataQuality.flowCount).toBe(3);
    expect(r.dataQuality.warnings.some((w) => w.toLowerCase().includes('transfer'))).toBe(false);
  });
});

// ═════════════════════════════════════════════════════════ 7. a single year

describe('shape: one year of data', () => {
  // INTERACTION.md, error table: "Only one year of data — Compute, but
  // suppress the year-by-year visual and say why."
  const rows: InputRow[] = [
    contribution('2025-01-15', 10_000),
    balance('2025-01-31', 10_000),
    balance('2025-06-30', 10_600),
    balance('2025-12-31', 11_000),
  ];

  it('computes', () => {
    const r = run(rows);
    expect(Number.isFinite(r.you.xirr)).toBe(true);
    expect(r.endingValue).toBe(11_000);
    expect(Number.isFinite(r.capture.pctKept)).toBe(true);
  });

  it('gives a UI enough to suppress the year-by-year visual', () => {
    // JUDGEMENT on the mechanism: the engine carries no "suppress" flag, and
    // adding one would put a rendering decision in a pure maths module. What
    // it does carry is `periods`, and one entry means there is nothing to
    // compare a year against. That is the signal, and pinning it here is what
    // makes it a contract rather than an accident.
    const r = run(rows);
    expect(Object.keys(r.periods)).toEqual(['2025']);
    expect(Object.keys(r.you.annual)).toEqual(['2025']);
    expect(r.dataQuality.spanMonths).toBe(12);
  });

  it('says why, in the warnings, rather than leaving a hole', () => {
    const r = run(rows);
    // The single period is a stub — 334 days, opening at the first balance
    // rather than at 31 December — and the copy has to say so, because a
    // reader will otherwise take it for an annual return.
    expect(r.periods['2025'].days).toBe(days('2025-01-31', '2025-12-31'));
    expect(r.dataQuality.warnings.length).toBeGreaterThan(0);
  });

  it('suppresses capture asymmetry, which needs several years to mean anything', () => {
    // deriveFindings requires 2 up periods and 1 down before it will speak.
    expect(ids(run(rows))).not.toContain('capture-asymmetry');
  });
});

// ════════════════════════════════════ 8. balance before the first contribution

describe('shape: balance dated before the first contribution', () => {
  // THE RULE: the first balance is opening capital when it is dated before the
  // first flow. The input format already says which is which — `balance` is
  // "the account was worth this", `contribution` is "I added this" — so there
  // is nothing to guess and no reason to wait for a user to be asked.
  //
  // INTERACTION.md's "ask whether that's an opening balance; offer to convert
  // it" is UI guidance and still applies: the flag below is what lets the UI
  // ask. It is not a licence for the engine to answer wrongly meanwhile, which
  // is what it did — 50,000 of opening capital counted as gain, a 62%
  // money-weighted return on 10,000 contributed, and an `outperformed`
  // verdict built on money it never saw arrive.
  const rows: InputRow[] = [
    balance('2021-10-31', 50_000),
    contribution('2022-01-15', 10_000),
    balance('2026-07-31', 90_000),
  ];

  it('treats the pre-flow balance as opening capital', () => {
    const r = run(rows);
    expect(r.openingPosition).toBe(50_000);
    // `netContributed` still reports what the user actually paid in during the
    // period, which is 10,000. The opening 50,000 is capital, not a
    // contribution, and conflating the two is what the separate field avoids.
    expect(r.netContributed).toBe(10_000);
    expect(r.gain).toBe(30_000); // 90,000 ending on 60,000 of capital
  });

  it('no longer produces the 62% return it used to', () => {
    const r = run(rows);
    // Was 0.6221 — a return on 10,000 while ignoring the 50,000 underneath it.
    expect(r.you.xirr).toBeCloseTo(0.0897759, 6);
    expect(r.you.xirr).toBeLessThan(0.15);
    // Independent: one in at 2021-10-31, one at 2022-01-15, 90,000 out. The
    // closed form only exists for two flows, so this brackets rather than
    // solves — 60,000 to 90,000 over the full span is the floor, and over the
    // shorter span from the second contribution is the ceiling.
    expect(r.you.xirr).toBeGreaterThan(twoFlowXirr('2021-10-31', '2026-07-31', 60_000, 90_000));
    expect(r.you.xirr).toBeLessThan(twoFlowXirr('2022-01-15', '2026-07-31', 60_000, 90_000));
  });

  it('no longer claims an outperformance it never earned', () => {
    const r = run(rows);
    // Was `forgone` -73,762 and `pctKept` 12.82 — a "share kept" of 1282%,
    // which should never have been renderable.
    expect(r.capture.forgone).toBeGreaterThan(0);
    expect(r.capture.forgone).toBeCloseTo(8_449.477, 3);
    expect(r.capture.kept).toBe(30_000);
    expect(r.capture.pctKept).toBeCloseTo(0.780245, 6);
    expect(r.capture.pctKept).toBeLessThan(1);
    expect(ids(r)).not.toContain('outperformed');
  });

  it('agrees with the same history entered as an explicit opening contribution', () => {
    // The strongest form of the rule: whichever way the user describes the
    // opening 50,000, the economics must come out the same. The two inputs
    // differ only in what they CALL it, so only `netContributed` and
    // `openingPosition` may differ — every derived figure must match exactly.
    const converted: InputRow[] = [
      contribution('2021-10-31', 50_000),
      balance('2021-10-31', 50_000),
      contribution('2022-01-15', 10_000),
      balance('2026-07-31', 90_000),
    ];
    const a = run(rows);
    const b = run(converted);

    expect(b.openingPosition).toBe(0);
    expect(b.netContributed).toBe(60_000);
    expect(b.dataQuality.balanceBeforeFirstFlow).toBe(null);

    // Everything downstream is identical, to the last bit.
    expect(a.you.xirr).toBe(b.you.xirr);
    expect(a.gain).toBe(b.gain);
    expect(a.capture.available).toBe(b.capture.available);
    expect(a.capture.kept).toBe(b.capture.kept);
    expect(a.capture.forgone).toBe(b.capture.forgone);
    expect(a.capture.pctKept).toBe(b.capture.pctKept);
    expect(ref(a).endingValue).toBe(ref(b).endingValue);
    expect(ids(a)).toEqual(ids(b));
    // And the invested base is the same 60,000 by either route.
    expect(a.netContributed + a.openingPosition).toBe(b.netContributed + b.openingPosition);
  });

  it('still flags the assumption so the UI can ask about it', () => {
    // The engine now computes the right answer AND discloses the assumption.
    // What the user alone knows is whether that balance belongs in the history
    // at all — the engine cannot tell an opening position from a stray row.
    const r = run(rows);
    expect(r.dataQuality.balanceBeforeFirstFlow).toBe('2021-10-31');
    const w = r.dataQuality.warnings.find((x) => x.includes('before your first contribution'));
    expect(w).toBeDefined();
    expect(w).toContain('2021-10-31');
    expect(w).toContain('2022-01-15');
    expect(w).toContain('treated as money already invested on that date rather than as gain');
    expect(w).toContain('If the account was actually empty until then');
    // The old copy told the user the figures were overstated. They are not.
    expect(w).not.toContain('overstate');
  });

  it('opens on capital when the first flow is a WITHDRAWAL', () => {
    // The rule is about the first flow of either kind, and it has to be:
    // money cannot be withdrawn from an account that was never funded, so a
    // balance preceding a withdrawal is unambiguously opening capital.
    const r = run([
      balance('2021-10-31', 50_000),
      withdrawal('2022-01-15', 5_000),
      balance('2026-07-31', 70_000),
    ]);
    expect(r.openingPosition).toBe(50_000);
    expect(r.grossWithdrawn).toBe(5_000);
    expect(r.netContributed).toBe(-5_000);
    // 70,000 ending, 45,000 of capital left in after the withdrawal.
    expect(r.gain).toBe(25_000);
    expect(r.you.xirr).toBeCloseTo(0.0969768, 6);
    expect(ids(r)).not.toContain('outperformed');
  });

  it('is not tripped by a first balance of exactly zero', () => {
    // An account opened but not yet funded. There is no capital, so there is
    // no opening position, no assumption to disclose, and nothing to warn
    // about — but the analysis must still run normally.
    const r = run([
      balance('2021-10-31', 0),
      contribution('2022-01-15', 10_000),
      balance('2026-07-31', 15_000),
    ]);
    expect(r.openingPosition).toBe(0);
    expect(r.netContributed).toBe(10_000);
    expect(r.gain).toBe(5_000);
    expect(r.you.xirr).toBeCloseTo(0.0933660, 6);
    // The factual flag still describes the rows honestly...
    expect(r.dataQuality.balanceBeforeFirstFlow).toBe('2021-10-31');
    // ...but nothing was assumed, so nothing is disclosed.
    expect(r.dataQuality.warnings.some((w) => w.includes('first balance'))).toBe(false);
  });

  it('still refuses only where there is genuinely no capital', () => {
    // `no-invested-capital` is for no flows AND no opening balance. A zero
    // opening balance with flows is fine (above); zero with nothing else is
    // not, because there is no capital for a return to be a return on.
    expect(() => run([balance('2021-10-31', 0), balance('2026-07-31', 15_000)])).toThrow();
    expect(() => run([
      balance('2021-10-31', 0),
      contribution('2022-01-15', 10_000),
      balance('2026-07-31', 15_000),
    ])).not.toThrow();
  });

  it('does not flag a first balance that merely shares its date with the flow', () => {
    // The fixture's own shape is contribution-then-balance; this guards the
    // boundary so the rule cannot start engaging on ordinary inputs. Same-day
    // means the balance already contains the contribution, so counting both
    // would double-count it.
    const r = run([
      contribution('2021-10-31', 50_000),
      balance('2021-10-31', 50_000),
      balance('2026-07-31', 90_000),
    ]);
    expect(r.dataQuality.balanceBeforeFirstFlow).toBe(null);
    expect(r.openingPosition).toBe(0);
    expect(r.netContributed).toBe(50_000);
  });
});

// ═══════════════════════════════════════════════════════ 9. shared invariants

describe('invariants across every synthetic shape', () => {
  const shapes: Record<string, InputRow[]> = {
    'lump sum': [balance('2021-10-31', 100_000), balance('2023-12-31', 118_000),
                 balance('2026-07-31', 150_000)],
    declining: yearEndPath(100_000, -0.06),
    growing: yearEndPath(50_000, 0.11),
    'with a withdrawal': [contribution('2021-10-12', 40_000), balance('2021-10-31', 40_000),
                          withdrawal('2023-06-15', 12_000), balance('2023-12-31', 31_000),
                          balance('2026-07-31', 44_000)],
    'single year': [contribution('2025-01-15', 10_000), balance('2025-01-31', 10_000),
                    balance('2025-12-31', 11_000)],
  };

  for (const [name, rows] of Object.entries(shapes)) {
    it(`${name}: the capture identities hold`, () => {
      const r = run(rows, { feePct: 0.0085 });
      expect(r.capture.forgone).toBeCloseTo(r.capture.available - r.capture.kept, 6);
      expect(r.capture.kept).toBeCloseTo(r.endingValue - r.netContributed - r.openingPosition, 6);
      expect(r.gain).toBeCloseTo(r.capture.kept, 6);
      expect(r.netContributed).toBeCloseTo(r.grossContributed - r.grossWithdrawn, 6);
      if (r.capture.forgone > 0) {
        expect(r.capture.feeShare + r.capture.otherShare).toBeCloseTo(r.capture.forgone, 6);
      } else {
        // JUDGEMENT: when there is no gap there is nothing to attribute, so
        // both shares are 0 and the identity above does NOT hold. Pinned
        // because a UI stacking the two bars has to know.
        expect(r.capture.feeShare).toBe(0);
        expect(r.capture.otherShare).toBe(0);
      }
    });

    it(`${name}: periods key one-for-one onto the annual series`, () => {
      const r = run(rows);
      expect(Object.keys(r.periods)).toEqual(Object.keys(r.you.annual));
      for (const p of Object.values(r.periods)) {
        expect(p.days).toBe(days(p.start, p.end));
        expect(p.partial).toBe(p.days < 330);
      }
    });

    it(`${name}: every strategy in the catalogue produces a result`, () => {
      const r = run(rows);
      expect(r.strategies.map((s) => s.id).sort()).toEqual(strategies.map((s) => s.id).sort());
      for (const s of r.strategies) {
        expect(Number.isFinite(s.endingValue)).toBe(true);
        expect(s.path).toHaveLength(r.dataQuality.spanMonths);
        expect(s.vsYou).toBeCloseTo(s.endingValue - r.endingValue, 6);
      }
    });

    it(`${name}: data quality describes the input it was given`, () => {
      const r = run(rows);
      expect(r.dataQuality.balanceCount).toBe(rows.filter((x) => x.type === 'balance').length);
      expect(r.dataQuality.flowCount).toBe(rows.filter((x) => x.type !== 'balance').length);
      expect(r.dataQuality.coverage)
        .toBeCloseTo(r.dataQuality.observedMonths / r.dataQuality.spanMonths, 12);
      expect(r.dataQuality.firstDate <= r.dataQuality.lastDate).toBe(true);
    });
  }

  it('finds no flow-free window shorter than the three-month minimum', () => {
    for (const rows of Object.values(shapes)) {
      for (const w of run(rows).flowFreeWindows) expect(w.months).toBeGreaterThanOrEqual(3);
    }
    // And the helper's own contract, exercised directly on a shape with none.
    expect(findFlowFreeWindows(
      [{ date: toDate('2025-01-31'), value: 100 }, { date: toDate('2025-02-28'), value: 110 }],
      [], 3)).toHaveLength(0);
  });

  it('leaves the real fixture with none of the new machinery engaged', () => {
    // The two fields this work added are inert on every history that has
    // flows and opens with a contribution — which is the real portfolio.
    // Proved separately by diffing the whole `analyse` result against the
    // pre-change engine: identical, save these two additions.
    const fixture = fixturesJson as unknown as {
      input: Omit<PortfolioInput, 'holdings'>;
      holdings: NonNullable<PortfolioInput['holdings']>;
    };
    const r = analyse(
      { ...fixture.input, holdings: fixture.holdings },
      benchmarks, strategies, referenceId, NOW);
    // And WHY it is inert: the first row is a contribution, and the first
    // balance is dated after it, so that balance already contains the
    // contribution. Counting both would double-count it.
    const first = fixture.input.rows[0];
    const firstBalance = fixture.input.rows.find((x) => x.type === 'balance')!;
    expect(first.type).toBe('contribution');
    expect(first.date).toBe('2021-10-12');
    expect(firstBalance.date).toBe('2021-10-31');
    expect(firstBalance.date > first.date).toBe(true);

    expect(r.openingPosition).toBe(0);
    expect(r.dataQuality.balanceBeforeFirstFlow).toBe(null);
    // And the two figures the brief pins, to full precision.
    expect(r.endingValue).toBe(53690.25);
    expect(r.you.xirr).toBe(0.10054387101873885);
    expect(r.gain).toBe(r.endingValue - r.netContributed);
  });

  it('is deterministic for a fixed `now`', () => {
    for (const rows of Object.values(shapes)) {
      expect(JSON.stringify(run(rows))).toBe(JSON.stringify(run(rows)));
    }
    expect(NOW.toISOString()).toBe('2026-08-18T00:00:00.000Z');
  });
});
