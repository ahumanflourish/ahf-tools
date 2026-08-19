/**
 * Internal-transfer detection.
 *
 * Pure. No DOM, no network, no Node APIs, no wall clock.
 *
 * WHY THIS IS IN CORE AND NOT IN THE EXTRACTION PROMPT.
 *
 * INTERACTION.md, review table: "Transfer detection runs here, in code, not
 * only in the prompt. If two flows of equal magnitude and opposite sign fall
 * within ~7 days, surface them together and ask whether they were an internal
 * transfer. This caught a $11,375 misstatement in the original analysis and it
 * should not depend on the model noticing."
 *
 * WHY IT MATTERS ARITHMETICALLY, which is the part a prompt cannot be trusted
 * with. `replay` nets flows within a calendar month before applying them, so
 * an equal-and-opposite pair INSIDE one month cancels exactly: the reference
 * ending value is untouched and only XIRR moves, by about 1.7 basis points on
 * an 11,375 four-day round trip. A pair that STRADDLES a month boundary does
 * not cancel — the reference is handed a full month of return on money that
 * was never invested. Measured on the synthetic shape in `synthetic.test.ts`
 * §6: a 29 March / 3 April pair moves the reference ending value by $434.69
 * and the headline `capture.pctKept` by more than 0.1pp. Both cases are
 * asserted in `transfers.test.ts`.
 *
 * That asymmetry is why `MatchedFlow` carries `straddlesMonthBoundary` and
 * `impact`: the UI can ask about every pair, but it can also tell the user
 * which pairs actually move the answer.
 *
 * WHAT THIS MODULE DOES NOT DO. It never mutates, filters or excludes. It
 * returns candidates for a human to rule on — "Do not auto-exclude anything;
 * the user decides." Equal-and-opposite flows a week apart are a *very* good
 * signal for an inter-account transfer and a perfectly ordinary pattern for
 * someone who contributed and then had to take the money back out for a real
 * expense. Only the account holder knows which.
 */
import { daysBetween, toDate, ym } from './engine';
import type { InputRow } from './engine';

// ───────────────────────────────────────────────────────────── parameters

/**
 * Maximum calendar days between the two legs, inclusive.
 *
 * INTERACTION.md says "within ~7 days" and 7 is also the defensible number on
 * its own: an ACH transfer settles in 1–3 business days, a trustee-to-trustee
 * rollover or a mailed check clears in under a week, and a Friday instruction
 * lands the following Wednesday once a holiday is in the way. Seven calendar
 * days covers all of that with one weekend of slack.
 *
 * The cost of going wider is false positives on real money. The reference
 * fixture contains `2024-11-15 +875` and `2025-01-15 -875` — equal magnitude,
 * opposite sign, 61 days apart, and emphatically not a transfer. A 30-day
 * window would flag it and teach the user to dismiss the prompt.
 */
export const TRANSFER_WINDOW_DAYS = 7;

/**
 * Absolute floor on the amount tolerance, in currency units.
 *
 * One cent. Amounts arrive as IEEE doubles through a parser that divides and
 * rounds, so `11375 === 11375` is not something to rely on; a cent is below
 * the resolution of any statement and above the noise.
 */
export const TRANSFER_ABS_TOLERANCE = 0.01;

/**
 * Relative amount tolerance, as a fraction of the larger leg.
 *
 * Ten basis points. A transfer is not always equal on both sides: a wire fee,
 * a fractional-share liquidation, or a receiving custodian rounding to the
 * cent all shave a little off the arriving leg. On the 11,375 case that is
 * $11.38 of slack — enough to survive a $25 wire fee? No, and deliberately
 * not: 10bp is tight enough that two genuinely different amounts ($3,000 and
 * $3,100) never pair, which is the failure that would make the prompt noise.
 * A caller who knows their custodian charges a flat fee can widen it.
 */
export const TRANSFER_REL_TOLERANCE = 0.001;

export interface FindMatchedFlowsOptions {
  /** Maximum calendar days between legs, inclusive. Default 7. */
  days?: number;
  /** Absolute amount tolerance. Default 0.01. */
  absTolerance?: number;
  /** Relative amount tolerance, fraction of the larger leg. Default 0.001. */
  relTolerance?: number;
  /**
   * Whether a contribution and a withdrawal on the SAME day may pair.
   * Default true — see `MatchedFlow.direction`.
   */
  allowSameDay?: boolean;
}

// ───────────────────────────────────────────────────────────── result shape

/** One leg of a candidate pair, with its position in the caller's array. */
export interface MatchedLeg {
  /** Index into the `rows` array passed in, so the UI can address the row. */
  index: number;
  date: string;
  amount: number;
}

export interface MatchedFlow {
  /** The money-in leg. */
  contribution: MatchedLeg;
  /** The money-out leg. */
  withdrawal: MatchedLeg;
  /** Mean of the two magnitudes — what to quote in the prompt copy. */
  amount: number;
  /** `|contribution.amount - withdrawal.amount|`. Zero for an exact match. */
  amountDelta: number;
  /** Calendar days between the legs, absolute. 0 for a same-day pair. */
  daysApart: number;
  /** Which leg came first. Both orders are ordinary; the copy differs. */
  direction: 'same-day' | 'out-then-in' | 'in-then-out';
  /**
   * True when the legs fall in different calendar months.
   *
   * This is the field that matters. `replay` nets flows per calendar month, so
   * a same-month pair cancels and a straddling pair does not — see the module
   * comment and `synthetic.test.ts` §6.
   */
  straddlesMonthBoundary: boolean;
  /**
   * What excluding this pair would change.
   *
   * - `reference-and-xirr` — straddles a month boundary; the reference ending
   *   value and therefore the headline capture figure move.
   * - `xirr-only` — inside one month; `netContributed`, `endingValue` and the
   *   reference ending value are all unchanged and only the money-weighted
   *   return shifts, by basis points.
   *
   * In BOTH cases `grossContributed` and `grossWithdrawn` move by the full
   * amount, which is usually what the user came to check.
   */
  impact: 'reference-and-xirr' | 'xirr-only';
  /**
   * How many OTHER opposite-sign flows were also within tolerance and window
   * of these legs when this pair was chosen. Zero means the match was
   * unambiguous; non-zero means a cluster of equal amounts and the pairing is
   * one defensible reading among several. The UI should say so.
   */
  competingCandidates: number;
}

// ─────────────────────────────────────────────────────────────── internals

interface Flow {
  index: number;
  date: string;
  time: number;
  amount: number;
  kind: 'contribution' | 'withdrawal';
}

interface Candidate {
  c: Flow;
  w: Flow;
  daysApart: number;
  amountDelta: number;
}

// ────────────────────────────────────────────────────────────────── public

/**
 * Find pairs of flows with equal magnitude and opposite sign falling within
 * `days` calendar days of each other.
 *
 * Rows are read, never written. Balance rows are ignored. Rows whose date is
 * not a real calendar date are ignored rather than throwing — the parser is
 * the guard for that, and a detector that crashes on a half-typed table is
 * useless in a live-editing UI.
 *
 * PAIRING RULE, and why it is greedy rather than optimal.
 *
 * Every (contribution, withdrawal) pair that satisfies both tolerances is a
 * candidate. Candidates are sorted by smallest date gap, then smallest amount
 * difference, then earliest date, then lowest index — a total order, so the
 * output is deterministic for a given input and does not depend on row order
 * beyond what the indices already encode. Candidates are then consumed in that
 * order and **each row is used at most once**.
 *
 * With three or more flows of the same magnitude clustered together this is
 * what stops the combinatorial explosion: six equal flows produce at most
 * three pairs, not nine, and no row appears in two prompts. It is not the
 * globally optimal matching — a maximum-weight bipartite matching would be —
 * and it does not need to be. This output is a question put to a human, not a
 * settlement. Tightest-first is the reading a person would arrive at, and
 * `competingCandidates` tells them when there was more than one reading.
 *
 * Complexity: candidates are generated only within amount-equal clusters and
 * only while the date window holds, so this is near-linear on real data rather
 * than O(n^2) over every flow.
 */
export function findMatchedFlows(
  rows: readonly InputRow[],
  options: FindMatchedFlowsOptions = {},
): MatchedFlow[] {
  const windowDays = options.days ?? TRANSFER_WINDOW_DAYS;
  const absTol = options.absTolerance ?? TRANSFER_ABS_TOLERANCE;
  const relTol = options.relTolerance ?? TRANSFER_REL_TOLERANCE;
  const allowSameDay = options.allowSameDay ?? true;

  const flows: Flow[] = [];
  rows.forEach((r, index) => {
    if (r.type !== 'contribution' && r.type !== 'withdrawal') return;
    if (!Number.isFinite(r.amount)) return;
    const time = toDate(r.date).getTime();
    if (!Number.isFinite(time)) return;
    // A zero flow pairs with every other zero flow and means nothing.
    if (Math.abs(r.amount) < absTol) return;
    flows.push({ index, date: r.date, time, amount: Math.abs(r.amount), kind: r.type });
  });

  return matchFlows(flows, windowDays, absTol, relTol, allowSameDay);
}

/** Tolerance test, symmetric in the two legs. */
function withinTolerance(a: number, b: number, absTol: number, relTol: number): boolean {
  return Math.abs(a - b) <= Math.max(absTol, relTol * Math.max(a, b));
}

function matchFlows(
  flows: Flow[],
  windowDays: number,
  absTol: number,
  relTol: number,
  allowSameDay: boolean,
): MatchedFlow[] {
  // Sort by amount so equal-magnitude flows sit together; a forward scan then
  // only has to walk while the tolerance still holds.
  const byAmount = [...flows].sort((a, b) => a.amount - b.amount || a.time - b.time || a.index - b.index);

  const candidates: Candidate[] = [];
  for (let i = 0; i < byAmount.length; i++) {
    for (let j = i + 1; j < byAmount.length; j++) {
      const a = byAmount[i];
      const b = byAmount[j];
      if (!withinTolerance(a.amount, b.amount, absTol, relTol)) break; // sorted: no later j can match
      if (a.kind === b.kind) continue;
      const gap = Math.abs(daysBetween(toDate(a.date), toDate(b.date)));
      if (gap > windowDays) continue;
      if (gap === 0 && !allowSameDay) continue;
      const c = a.kind === 'contribution' ? a : b;
      const w = a.kind === 'withdrawal' ? a : b;
      candidates.push({ c, w, daysApart: gap, amountDelta: Math.abs(a.amount - b.amount) });
    }
  }

  // How many candidates each flow appears in, before any are consumed. This is
  // the cluster size the user needs to be told about.
  const appearances = new Map<number, number>();
  for (const cand of candidates) {
    appearances.set(cand.c.index, (appearances.get(cand.c.index) ?? 0) + 1);
    appearances.set(cand.w.index, (appearances.get(cand.w.index) ?? 0) + 1);
  }

  candidates.sort(
    (x, y) =>
      x.daysApart - y.daysApart ||
      x.amountDelta - y.amountDelta ||
      Math.min(x.c.time, x.w.time) - Math.min(y.c.time, y.w.time) ||
      Math.min(x.c.index, x.w.index) - Math.min(y.c.index, y.w.index),
  );

  const used = new Set<number>();
  const out: MatchedFlow[] = [];
  for (const cand of candidates) {
    if (used.has(cand.c.index) || used.has(cand.w.index)) continue;
    used.add(cand.c.index);
    used.add(cand.w.index);
    const straddles = ym(toDate(cand.c.date)) !== ym(toDate(cand.w.date));
    // -2 because each leg counts this very pair among its appearances.
    const competing =
      (appearances.get(cand.c.index) ?? 0) + (appearances.get(cand.w.index) ?? 0) - 2;
    out.push({
      contribution: { index: cand.c.index, date: cand.c.date, amount: cand.c.amount },
      withdrawal: { index: cand.w.index, date: cand.w.date, amount: cand.w.amount },
      amount: (cand.c.amount + cand.w.amount) / 2,
      amountDelta: cand.amountDelta,
      daysApart: cand.daysApart,
      direction:
        cand.daysApart === 0
          ? 'same-day'
          : cand.w.time < cand.c.time
            ? 'out-then-in'
            : 'in-then-out',
      straddlesMonthBoundary: straddles,
      impact: straddles ? 'reference-and-xirr' : 'xirr-only',
      competingCandidates: competing,
    });
  }

  // Chronological for display: the table is chronological, the cards above it
  // should be too. Ties broken by index so the order is total.
  return out.sort(
    (x, y) =>
      Math.min(Date.parse(x.contribution.date), Date.parse(x.withdrawal.date)) -
        Math.min(Date.parse(y.contribution.date), Date.parse(y.withdrawal.date)) ||
      Math.min(x.contribution.index, x.withdrawal.index) -
        Math.min(y.contribution.index, y.withdrawal.index),
  );
}
