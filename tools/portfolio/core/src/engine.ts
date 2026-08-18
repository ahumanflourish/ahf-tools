/**
 * Portfolio vs. Strategy — computational core.
 *
 * Pure functions. No DOM, no network, no framework. Everything here is
 * deterministic and unit-testable against fixtures.json.
 *
 * One input is not carried by the portfolio data: `currentAge` is an age as of
 * today, so the year it implies moves on 1 January. `analyse` and
 * `deriveFindings` therefore take an optional `now`, defaulting to the wall
 * clock. Pass it and the call is fully reproducible; omit it and only the
 * target-year check can drift.
 *
 * Vocabulary note: this module never says "advisor". A portfolio has a
 * `feePct`; it may be 0. The comparison is always "your strategy" versus
 * "reference strategies", which keeps it usable by DIY investors,
 * 401k holders and advised clients alike.
 */

// ─────────────────────────────────────────────────────────── types

/** A single row of user input. Dates are ISO `YYYY-MM-DD`. */
export type InputRow =
  | { date: string; type: 'contribution'; amount: number }
  | { date: string; type: 'withdrawal'; amount: number }
  | { date: string; type: 'balance'; amount: number };

export interface Holding {
  ticker: string;
  value: number;
  /** Optional classification; the tool can infer these from a lookup table. */
  assetClass?: 'us_equity' | 'intl_equity' | 'bond' | 'cash' | 'other';
  sizeBucket?: 'large' | 'mid' | 'small';
}

export interface PortfolioInput {
  rows: InputRow[];
  /** Annual advisory / platform fee as a fraction. 0 is valid and common. */
  feePct: number;
  /** Optional: enables factor attribution. */
  holdings?: { asOf: string; positions: Holding[] };
  /** Optional: enables the target-date-mismatch check. */
  currentAge?: number;
  /** Optional: enables the target-date-mismatch check. */
  statedTargetYear?: number;
  /**
   * Optional: the US share of global equity market capitalisation to compare
   * holdings against, as a fraction. Supply this to override the value derived
   * from the benchmark data — a user may hold a different, defensible view of
   * what "market weight" means, and this is a judgement input, not a fact.
   */
  usMarketWeight?: number;
}

/** Monthly returns keyed `YYYY-MM`; annual keyed `YYYY`. Values are percent. */
export interface BenchmarkData {
  meta: { inception: Record<string, number>; [k: string]: unknown };
  annual: Record<string, Record<string, number | null>>;
  monthly: Record<string, Record<string, number>>;
}

export interface StrategyDef {
  id: string;
  label: string;
  /** Component series id → weight. Weights must sum to 1. */
  weights: Record<string, number>;
  /** ADDITIONAL annual drag beyond what is already inside the component series.
   *  Component series are fund total returns, already net of fund expenses,
   *  so this is normally 0. Use it for platform fees layered on top. */
  expenseRatio: number;
  rebalance?: 'annual' | 'monthly' | 'never';
  /** Shown to the user before they select it. */
  explainer: string;
  /** Non-null triggers a visible caution when this strategy is displayed. */
  caution?: string;
}

export interface StrategyResult {
  id: string;
  label: string;
  endingValue: number;
  xirr: number;
  /** Ending value minus the user's ending value. */
  vsYou: number;
  path: { date: string; value: number }[];
  annual: Record<string, number>;
}

/**
 * Metadata for one entry in `you.annual`.
 *
 * `you.annual` is keyed by calendar year, but the window it actually measures
 * runs from the previous year's closing balance to this year's, so the first
 * and last years are usually stubs covering only part of the year. Those
 * returns are NOT annualised — each is the raw return over `days`. Anything
 * that compares periods with one another, or renders them side by side, needs
 * to know which are stubs, which is what this record carries.
 */
export interface PeriodInfo {
  /** Date of the opening balance. ISO `YYYY-MM-DD`. */
  start: string;
  /** Date of the closing balance. ISO `YYYY-MM-DD`. */
  end: string;
  /** Calendar days from `start` to `end`. */
  days: number;
  /** True when the window is materially shorter than a full calendar year. */
  partial: boolean;
}

/**
 * Day count at or above which a Modified Dietz period counts as a full year.
 *
 * JUDGEMENT CALL — the spec does not define this, so the number is chosen
 * rather than derived. A full calendar-year window runs 365 or 366 days
 * (previous year-end balance → this year-end balance). Stub periods are much
 * shorter: the reference fixture's 2021 covers 61 days (2021-10-31 →
 * 2021-12-31) and its 2026 covers 212 (2025-12-31 → 2026-07-31).
 *
 * 330 days (~10.8 months) leaves roughly a month of slack, so a balance dated
 * 2024-12-27 rather than 2024-12-31 — or a history opening on 2021-01-08 —
 * still measures as a full year, while any genuinely short stub is caught.
 * Every real value in the fixture sits far from the boundary, so any cutoff
 * between ~220 and ~360 classifies it identically; the exact figure is not
 * load-bearing.
 */
const FULL_PERIOD_DAYS = 330;

/**
 * How dense the user's balance history is, as a cadence the user recognises.
 *
 * WHY FOUR AND NOT THREE. The previous three-bucket split put the boundary
 * between `annual` and `monthly` at 80% of months observed, and everything
 * from one observation a year up to 79% coverage landed in `annual`. Over a
 * 58-month history that single bucket held anything from 5 balances to 46 —
 * it told someone with a balance every other month that their figures were
 * annual-grade, which is the same class of error the tool exists to expose.
 *
 * SPEC.md's three input tiers are about how much WORK the user does, not how
 * dense the result is, and they only anchor two points on this scale: tier 1
 * (year-end balances) lands on `annual`, tier 2 (monthly balances) lands on
 * `monthly`, and tier 3 adds a holdings snapshot, which changes which findings
 * can fire and not the balance density at all. Real histories sit between the
 * two anchors — quarterly statements are the commonest cadence anyone actually
 * has — and below tier 1 there is data too thin to support a yearly figure.
 * Hence four: the two tier anchors, the gap between them, and the floor below.
 */
export type Granularity = 'monthly' | 'quarterly' | 'annual' | 'sparse';

/**
 * Upper bounds, in mean months per observation, for each bucket.
 *
 * JUDGEMENT CALL, like FULL_PERIOD_DAYS. Cadence is multiplicative — the step
 * from monthly to quarterly is the same size as quarterly to annual — so the
 * boundaries sit at the geometric mean of the nominal cadences they separate:
 * sqrt(1 x 3) = 1.73 (rounded to 1.75) and sqrt(3 x 12) = 6. The floor below
 * `annual` is 18, one and a half years, so a history that misses one year-end
 * is still annual data with a hole rather than something else entirely.
 *
 * These are means over the whole span, so they describe aggregate density and
 * nothing about where the holes are. `largestGapMonths` carries that, and the
 * warnings say it out loud when the two disagree.
 */
export const GRANULARITY_MAX_INTERVAL: Record<Exclude<Granularity, 'sparse'>, number> = {
  monthly: 1.75,
  quarterly: 6,
  annual: 18,
};

/**
 * Classify a balance history by mean months per observation.
 *
 * Edge cases this is answerable for, all against a 58-month span unless said:
 *   2 balances over 5 years   -> interval ~30   -> sparse
 *   5 year-end balances       -> interval 11.6  -> annual
 *   8 year-end balances (85mo)-> interval 10.6  -> annual
 *   27 bi-monthly balances    -> interval 2.15  -> quarterly
 *   46 of 58 months           -> interval 1.26  -> monthly
 *   58 monthly balances       -> interval 1.00  -> monthly
 *
 * The label is deliberately conservative at the boundaries: the fixture's
 * 2.15-month cadence is denser than quarterly, and calling it `quarterly`
 * understates it. Understating precision is the safe direction; overstating
 * it is the defect.
 */
export function classifyGranularity(observedMonths: number, spanMonths: number): Granularity {
  if (observedMonths <= 0 || spanMonths <= 0) return 'sparse';
  const interval = spanMonths / observedMonths;
  if (interval <= GRANULARITY_MAX_INTERVAL.monthly) return 'monthly';
  if (interval <= GRANULARITY_MAX_INTERVAL.quarterly) return 'quarterly';
  if (interval <= GRANULARITY_MAX_INTERVAL.annual) return 'annual';
  return 'sparse';
}


export interface Finding {
  id: string;
  severity: 'info' | 'caution' | 'notable';
  title: string;
  detail: string;
}

export interface AnalysisResult {
  netContributed: number;
  grossContributed: number;
  grossWithdrawn: number;
  endingValue: number;
  /**
   * `endingValue` minus the capital that was put in — contributions net of
   * withdrawals, plus `openingPosition`.
   */
  gain: number;
  /**
   * Money already invested when the history opened, treated as such rather
   * than as a contribution.
   *
   * It is the first balance whenever that balance is dated before the first
   * flow — which includes the case of no flows at all — and zero otherwise,
   * because a balance dated after a contribution already contains it. See
   * `analyse` for the full rule.
   */
  openingPosition: number;
  you: { xirr: number; annual: Record<string, number> };
  /**
   * Window metadata for each key of `you.annual`, same keys, same order.
   * `you.annual` deliberately still reports every period including the stubs —
   * the year-by-year visual shows all of them and footnotes the partial ones —
   * so this is how a consumer tells a full year from a stub.
   */
  periods: Record<string, PeriodInfo>;
  strategies: StrategyResult[];
  /** The strategy used as the "boring passive option" reference. */
  referenceId: string;
  capture: {
    available: number;
    kept: number;
    forgone: number;
    pctKept: number;
    pctForgone: number;
    feeShare: number;
    otherShare: number;
  };
  flowFreeWindows: { start: string; end: string; months: number; yourReturn: number }[];
  findings: Finding[];
  /**
   * The US market weight the `regional-tilt` check was measured against, with
   * its provenance. Surfaced so the UI can show the figure next to the finding
   * (VISUALS.md V5 requires the market-weight comparison alongside the holdings)
   * and label it honestly — a `derived` figure is inferred from return
   * correlation, not a sourced market-cap number.
   */
  marketWeight: MarketWeight;
  dataQuality: DataQuality;
}

/**
 * How much interpolation stands between the user's data and the answer.
 *
 * `granularity` is a label; everything around it is the evidence for that
 * label. Both are surfaced because SPEC.md non-negotiable 5 is that the tool
 * must not invent precision — a UI that shows only the word can say "annual"
 * and stop, where one that can also say "27 of 58 months" cannot mislead.
 */
export interface DataQuality {
  /** Balance ROWS supplied. Not the same as `observedMonths` — see below. */
  balanceCount: number;
  /**
   * Distinct calendar months carrying at least one balance row. This, not
   * `balanceCount`, is the number of markers V1 draws and the number the
   * classification is computed from: two balances inside one month tell you
   * about one month, not two.
   */
  observedMonths: number;
  /** Months from `firstDate` to `lastDate` inclusive — the analysis span. */
  spanMonths: number;
  /** `observedMonths / spanMonths`. 1 means a balance in every month. */
  coverage: number;
  /**
   * Largest run, in months, between two consecutive observed months.
   * 1 means no gaps anywhere; 0 when there is only one observation.
   * A large figure here alongside good `coverage` means the data is dense in
   * places and absent in others, which the average on its own would hide.
   */
  largestGapMonths: number;
  flowCount: number;
  /**
   * ISO date of the first balance when it predates the first flow, else null.
   *
   * A non-null value means the analysis treated that balance as opening
   * capital rather than as gain — see `AnalysisResult.openingPosition`. The
   * figures are right either way; what the user alone knows is whether the
   * balance itself belongs there at all. INTERACTION.md asks the UI to raise
   * it ("ask whether that's an opening balance"), and this is the signal to.
   */
  balanceBeforeFirstFlow: string | null;
  granularity: Granularity;
  firstDate: string;
  lastDate: string;
  warnings: string[];
}

// ─────────────────────────────────────────────────────── date helpers

const DAY = 86400000;
export const toDate = (s: string): Date => new Date(s + 'T00:00:00Z');
export const ym = (d: Date): string =>
  `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, '0')}`;
export const daysBetween = (a: Date, b: Date): number =>
  Math.round((b.getTime() - a.getTime()) / DAY);
export const yearsBetween = (a: Date, b: Date): number => daysBetween(a, b) / 365;

/** Inclusive list of `YYYY-MM` between two dates. */
export function monthRange(from: string, to: string): string[] {
  const out: string[] = [];
  let [y, m] = from.split('-').map(Number);
  const [ty, tm] = to.split('-').map(Number);
  while (y < ty || (y === ty && m <= tm)) {
    out.push(`${y}-${String(m).padStart(2, '0')}`);
    if (++m === 13) { m = 1; y++; }
  }
  return out;
}

export function monthEnd(key: string): string {
  const [y, m] = key.split('-').map(Number);
  const d = new Date(Date.UTC(y, m, 0));
  return d.toISOString().slice(0, 10);
}

// ─────────────────────────────────────────────────────────── returns

/**
 * Money-weighted return. Solves for the rate that zeroes the NPV of
 * `flows`, where negative amounts are money going in and the final
 * positive amount is the ending value.
 *
 * Bisection rather than Newton: slower but cannot diverge, which matters
 * because user data is arbitrary and we would rather be correct than fast.
 */
export function xirr(flows: { date: Date; amount: number }[]): number {
  if (flows.length < 2) return NaN;
  const sorted = [...flows].sort((a, b) => a.date.getTime() - b.date.getTime());
  const t0 = sorted[0].date;
  const npv = (r: number): number =>
    sorted.reduce(
      (s, f) => s + f.amount / Math.pow(1 + r, yearsBetween(t0, f.date)),
      0,
    );
  let lo = -0.9999, hi = 10;
  if (npv(lo) * npv(hi) > 0) return NaN; // no sign change → no solution
  for (let i = 0; i < 500; i++) {
    const mid = (lo + hi) / 2;
    if (npv(lo) * npv(mid) <= 0) hi = mid; else lo = mid;
  }
  return (lo + hi) / 2;
}

/**
 * Modified Dietz — approximates time-weighted return over a period,
 * weighting each flow by the fraction of the period it was invested.
 * EXACT when there are no flows; an approximation otherwise.
 */
export function modifiedDietz(
  startValue: number,
  endValue: number,
  flows: { date: Date; amount: number }[],
  periodStart: Date,
  periodEnd: Date,
): number {
  const days = daysBetween(periodStart, periodEnd);
  if (days <= 0) return NaN;
  const net = flows.reduce((s, f) => s + f.amount, 0);
  const weighted = flows.reduce(
    (s, f) => s + f.amount * (daysBetween(f.date, periodEnd) / days),
    0,
  );
  const denom = startValue + weighted;
  if (denom === 0) return NaN;
  return (endValue - startValue - net) / denom;
}

// ────────────────────────────────────────────────────── strategy build

/**
 * Blend component series into a single monthly return series, rebalancing
 * to target weights on the given cadence. Returns percent per month.
 */
export function buildStrategySeries(
  def: StrategyDef,
  data: BenchmarkData,
  months: string[],
): Record<string, number> {
  const ids = Object.keys(def.weights);
  const targets = ids.map((id) => def.weights[id]);
  let bal = [...targets];
  const out: Record<string, number> = {};
  const feeMonthly = Math.pow(1 - def.expenseRatio, 1 / 12);

  months.forEach((mk, i) => {
    if (def.rebalance !== 'never') {
      const isJan = mk.endsWith('-01');
      if ((def.rebalance === 'monthly' && i > 0) || (isJan && i > 0)) {
        const tot = bal.reduce((a, b) => a + b, 0);
        bal = targets.map((w) => tot * w);
      }
    }
    const before = bal.reduce((a, b) => a + b, 0);
    bal = bal.map((b, j) => {
      const r = data.monthly[ids[j]]?.[mk];
      if (r === undefined) throw new Error(`missing monthly ${ids[j]} ${mk}`);
      return b * (1 + r / 100);
    });
    const after = bal.reduce((a, b) => a + b, 0);
    // Expense ratio applied here so component series stay raw.
    out[mk] = (after / before * feeMonthly - 1) * 100;
  });
  return out;
}

/**
 * Replay a set of cash flows into a return series.
 * Flows are applied with a half-month convention by default, which matches
 * how most people actually contribute (spread through the month).
 */
export function replay(
  series: Record<string, number>,
  flows: { date: Date; amount: number }[],
  months: string[],
  flowWeight = 0.5,
): { path: { date: string; value: number }[]; ending: number } {
  let bal = 0;
  const path: { date: string; value: number }[] = [];
  for (const mk of months) {
    const r = (series[mk] ?? 0) / 100;
    const net = flows
      .filter((f) => ym(f.date) === mk)
      .reduce((s, f) => s + f.amount, 0);
    bal = bal * (1 + r) + net * Math.pow(1 + r, flowWeight);
    path.push({ date: monthEnd(mk), value: bal });
  }
  return { path, ending: bal };
}

// ────────────────────────────────────────────────────── flow-free windows

/**
 * Find stretches with no cash flows and a balance observation at each end.
 * Returns are EXACT in these windows, which makes them the most reliable
 * evidence available. Sparse-data portfolios lean on these; someone
 * contributing every fortnight will have none, which is fine — their
 * monthly balances give a good Dietz series instead.
 */
export function findFlowFreeWindows(
  balances: { date: Date; value: number }[],
  flows: { date: Date; amount: number }[],
  minMonths = 3,
): { start: string; end: string; months: number; yourReturn: number }[] {
  const out: { start: string; end: string; months: number; yourReturn: number }[] = [];
  const sorted = [...balances].sort((a, b) => a.date.getTime() - b.date.getTime());
  for (let i = 0; i < sorted.length; i++) {
    for (let j = sorted.length - 1; j > i; j--) {
      const a = sorted[i], b = sorted[j];
      const hasFlow = flows.some(
        (f) => f.date > a.date && f.date <= b.date && Math.abs(f.amount) > 0.005,
      );
      if (hasFlow) continue;
      const months = Math.round(daysBetween(a.date, b.date) / 30.44);
      if (months < minMonths) continue;
      out.push({
        start: a.date.toISOString().slice(0, 10),
        end: b.date.toISOString().slice(0, 10),
        months,
        yourReturn: b.value / a.value - 1,
      });
      break; // longest window from this start
    }
  }
  // keep only maximal, non-overlapping windows
  return out
    .sort((x, y) => y.months - x.months)
    .filter((w, i, arr) => !arr.slice(0, i).some((p) => w.start < p.end && w.end > p.start));
}

// ─────────────────────────────────────────────────── data-quality warnings

/** "2021", "2021 and 2026", "2021, 2023 and 2026". */
function joinList(items: string[]): string {
  if (items.length <= 1) return items[0] ?? '';
  return `${items.slice(0, -1).join(', ')} and ${items[items.length - 1]}`;
}

/** Plain-language cadence for a mean interval in months. */
function cadencePhrase(intervalMonths: number): string {
  const n = Math.round(intervalMonths);
  if (intervalMonths > 18) return 'fewer than one a year';
  if (n >= 11 && n <= 13) return 'about one a year';
  if (n <= 1) return 'roughly one a month';
  return `about one every ${n} months`;
}

/**
 * The user-facing `dataQuality.warnings` list.
 *
 * Every string here states a fact about THIS input, what it makes approximate,
 * and what would sharpen it — in that order, which is the pattern the existing
 * copy already used. Nothing fires speculatively: each condition is checked
 * against the data rather than assumed from the tier the user appears to be in.
 *
 * Kept as a separate exported function so the wording can be tested directly
 * and so a UI can regenerate it after the user edits the review table.
 */
export function dataQualityWarnings(args: {
  granularity: Granularity;
  observedMonths: number;
  spanMonths: number;
  largestGapMonths: number;
  /** Same object `analyse` returns, keyed by year in ascending order. */
  periods: Record<string, PeriodInfo>;
  /** Every calendar year carrying at least one balance row. */
  balanceYears: number[];
  flowDates: Date[];
  /**
   * ISO date of the balance being treated as opening capital, or null when
   * there is none. Optional: omitting it is the ordinary case.
   */
  openingPositionDate?: string | null;
  /** Whether the input carries any contributions or withdrawals at all. */
  hasFlows?: boolean;
  /** ISO date of a first balance that predates the first flow, else null. */
  balanceBeforeFirstFlow?: string | null;
  /** ISO date of the first flow. Only read alongside the field above. */
  firstFlowDate?: string | null;
}): string[] {
  const { granularity, observedMonths, spanMonths, largestGapMonths, periods } = args;
  const out: string[] = [];
  const interval = observedMonths > 0 ? spanMonths / observedMonths : Infinity;

  // 1. Density. How much of the line between the dots is drawn rather than
  //    observed, and what that costs. Silent at `monthly`, where there is
  //    nothing to warn about.
  // Worth saying separately when the holes are much bigger than the average
  // implies. A mean of "one every 2 months" and an 8-month blind spot are both
  // true at once, and only the first of them is reassuring.
  const lumpy = largestGapMonths >= 3 && largestGapMonths >= 2 * interval;

  if (granularity !== 'monthly') {
    const cover =
      `Balances cover ${observedMonths} of the ${spanMonths} months in this period — ` +
      `${cadencePhrase(interval)}` +
      (lumpy ? `, and the longest stretch without one runs ${largestGapMonths} months` : '') +
      '.';

    if (granularity === 'sparse') {
      out.push(
        `${cover} That is not enough to say much about any single year. Your return over ` +
        `the whole period is the figure to lean on — it needs only the dates and amounts, ` +
        `so it is unaffected. Year-end balances would sharpen everything else considerably.`);
    } else if (granularity === 'annual') {
      out.push(
        `${cover} Your year-by-year figures are the right shape but rough: within each year ` +
        `the return is estimated from your contribution dates rather than measured. ` +
        `Quarter-end or month-end balances would sharpen them.`);
    } else {
      out.push(
        `${cover} Between observations your value is drawn as a straight line rather than ` +
        `observed, and each period's return is estimated from your contribution dates ` +
        `rather than measured directly. Month-end balances would sharpen both.`);
    }
  } else if (lumpy) {
    // `monthly` suppresses the density warning, which would otherwise carry
    // the gap clause — so a history that is dense everywhere except for one
    // long hole would say nothing at all about the hole. It has to.
    out.push(
      `Balances cover ${observedMonths} of the ${spanMonths} months in this period, but the ` +
      `longest stretch without one runs ${largestGapMonths} months. Across that stretch your ` +
      `value is drawn as a straight line rather than observed, and any figure covering it is ` +
      `approximate rather than measured. A balance inside it would sharpen those periods.`);
  }

  // 2. Partial periods. `you.annual` reports these next to full years by
  //    design — V3 renders all of them — so the user has to be told which
  //    ones are not a year.
  const years = Object.keys(periods);
  const partial = years.filter((y) => periods[y].partial);
  const notAYear = (days: number): string =>
    `Its return is the plain return over those ${days} days, not annualised, so it should ` +
    `not be read alongside the full years as if it were one.`;

  if (partial.length > 2) {
    // Individually this would flood the list, so state the shape once.
    const detail = partial.map((y) => `${y} (${periods[y].days} days)`).join(', ');
    out.push(
      `${partial.length} of the ${years.length} periods cover less than a full year: ${detail}. ` +
      `Each is the plain return over its own window, not annualised, so they are not ` +
      `comparable with the full years or with one another. Year-end balances would make ` +
      `them comparable.`);
  } else {
    for (const y of partial) {
      const p = periods[y];
      const head = `${y} covers ${p.days} days (${p.start} to ${p.end}), not a full year. `;
      if (y === years[0]) {
        // The window opens at the first balance, so the remedy is an earlier
        // one — IF there was anything to observe. Stated conditionally
        // because for most people there was not: the account began here.
        out.push(
          `${head}${notAYear(p.days)} If the account existed before ${p.start}, adding an ` +
          `earlier balance would make it a full year.`);
      } else if (y === years[years.length - 1]) {
        // Short because the year is still running — but it can also be short
        // at its OPENING end, when no balance sits at the previous year end,
        // and then waiting will not fix the whole of it.
        const opensAtPriorYearEnd = p.start.slice(0, 7) === `${Number(y) - 1}-12`;
        out.push(
          opensAtPriorYearEnd
            ? `${head}${notAYear(p.days)} It fills in as the year completes.`
            : `${head}${notAYear(p.days)} A balance dated ${Number(y) - 1}-12-31 would line it ` +
              `up with the calendar year, and the rest fills in as the year completes.`);
      } else {
        const yr = Number(y);
        const opensAtPriorYearEnd = p.start.slice(0, 7) === `${yr - 1}-12`;
        const missing = opensAtPriorYearEnd ? `${yr}-12-31` : `${yr - 1}-12-31`;
        out.push(
          `${head}${notAYear(p.days)} A balance dated ${missing} would make it a full year.`);
      }
    }
  }

  // 3. Years that produced no figure at all. A year needs an opening balance
  //    before a closing one; a year holding a single balance, with none in the
  //    year before it, has nothing to measure from and is silently absent from
  //    `you.annual`. Silently is the problem.
  const unmeasured = args.balanceYears.filter((y) => !(String(y) in periods)).map(String);
  if (years.length === 0) {
    out.push(
      `No year-by-year return could be measured: no calendar year has both an opening and ` +
      `a closing balance. Your return over the whole period is unaffected — it needs only ` +
      `the flow dates and the final value. A balance at each year end would fill in the ` +
      `year-by-year comparison.`);
  } else if (unmeasured.length > 0) {
    out.push(
      `No year-by-year return could be measured for ${joinList(unmeasured)}: ` +
      `${unmeasured.length === 1 ? 'that year has' : 'those years have'} a single balance ` +
      `and none in the year before, so there is nothing to measure from. Your return over ` +
      `the whole period is unaffected. A balance at each year end would fill ` +
      `${unmeasured.length === 1 ? 'it' : 'them'} in.`);
  }

  // 4. Dates that look reconstructed rather than recorded. Unchanged rule and
  //    unchanged wording; it hedges ("usually") because a genuine monthly
  //    contributor on the 15th looks identical to an estimate.
  if (args.flowDates.length > 0 && !args.flowDates.some((d) => d.getUTCDate() !== 15)) {
    out.push(
      'All contributions appear to be dated mid-month, which usually means dates were estimated. ' +
      'Real transaction dates will improve accuracy.');
  }

  // 5 and 6. Opening capital. Neither is a warning about accuracy: the figures
  //    are right in both cases. Each states an ASSUMPTION the engine made from
  //    the row types — that a balance dated before any flow is money that was
  //    already there — which the user never stated and can only disagree with
  //    if told. Two wordings because the two shapes have different remedies.

  // 5. No flows at all: the whole analysis rests on that one opening figure.
  if (args.openingPositionDate && !args.hasFlows) {
    out.push(
      `No contributions or withdrawals were entered, so your first balance, dated ` +
      `${args.openingPositionDate}, is treated as money already invested on that date, and ` +
      `each reference strategy is given the same amount on the same day. Nothing was ` +
      `contributed during the period, so figures expressed as a share of contributions do ` +
      `not apply; the comparison is between what that opening amount became and what it ` +
      `would have become.`);
  }

  // 6. Flows exist, but a balance predates them. Silent on a zero opening
  //    balance — an account opened and not yet funded assumes nothing and
  //    changes nothing, so there is no assumption to disclose.
  if (args.balanceBeforeFirstFlow && args.openingPositionDate && args.hasFlows) {
    out.push(
      `Your first balance is dated ${args.balanceBeforeFirstFlow}, before your first ` +
      `contribution${args.firstFlowDate ? ` on ${args.firstFlowDate}` : ''}, so it is treated ` +
      `as money already invested on that date rather than as gain you made, and each ` +
      `reference strategy is given the same amount on the same day. If the account was ` +
      `actually empty until then, that balance does not belong in the history and removing ` +
      `it would change these figures.`);
  }

  return out;
}

// ──────────────────────────────────────────────── input validation & coverage

/**
 * Codes for the conditions `analyse` refuses to compute on.
 *
 * Every one of these is a row in INTERACTION.md's "Error and edge states"
 * table, and every one of them needs specific copy saying what to fix. A bare
 * `Error` cannot carry that — the UI would have to match on message text — so
 * the code and the facts the copy needs travel on the error itself.
 */
export type AnalysisErrorCode =
  /** Fewer than two balance rows: nothing to measure a period between. */
  | 'insufficient-balances'
  /** No flows AND no opening balance to stand in for them. */
  | 'no-invested-capital'
  /** History opens before the monthly benchmark series does. */
  | 'history-before-coverage'
  /** History closes after the monthly benchmark series does. */
  | 'history-after-coverage';

/**
 * Thrown by `analyse` for inputs it will not compute on.
 *
 * `instanceof AnalysisError` is the catchable contract; `code` selects the
 * copy; the remaining fields are the facts that copy needs. INTERACTION.md
 * requires the coverage cases to "name the earliest supported date and offer
 * to analyse the covered portion", so `earliestSupported`, `latestSupported`,
 * `coveredFrom` and `coveredTo` are populated for those two codes — the offer
 * is the UI's to make, but it cannot make it without these.
 */
export class AnalysisError extends Error {
  readonly code: AnalysisErrorCode;
  /** First date the benchmark data supports, ISO. Coverage errors only. */
  readonly earliestSupported?: string;
  /** Last date the benchmark data supports, ISO. Coverage errors only. */
  readonly latestSupported?: string;
  /**
   * The part of the user's own history that IS covered, ISO, or null when
   * none of it is. Coverage errors only.
   */
  readonly coveredFrom?: string | null;
  readonly coveredTo?: string | null;
  /** Balance rows supplied. `insufficient-balances` only. */
  readonly balanceCount?: number;

  constructor(
    code: AnalysisErrorCode,
    message: string,
    extra: Partial<Omit<AnalysisError, 'code' | 'name' | 'message'>> = {},
  ) {
    super(message);
    this.name = 'AnalysisError';
    this.code = code;
    Object.assign(this, extra);
  }
}

/**
 * The span of months every series these strategies need is present for.
 *
 * `buildStrategySeries` throws a developer-facing `missing monthly X YYYY-MM`
 * the moment it walks off the end of the data, which surfaces to a user as an
 * uncaught crash. Computing the window up front turns that into the specific,
 * catchable error INTERACTION.md asks for.
 *
 * Only the series the given strategies actually reference are considered: a
 * catalogue entry nobody selected should not narrow anyone's supported range.
 * Interior holes are not detected here — the shipped data has none, and
 * `buildStrategySeries` remains the backstop if that ever changes.
 */
export function benchmarkCoverage(
  data: BenchmarkData,
  strategies: StrategyDef[],
): { firstMonth: string; lastMonth: string } | null {
  const ids = [...new Set(strategies.flatMap((d) => Object.keys(d.weights)))];
  let firstMonth = '';
  let lastMonth = '';
  for (const id of ids) {
    const keys = Object.keys(data.monthly[id] ?? {}).sort();
    if (keys.length === 0) return null;
    // Intersection: the latest start and the earliest end across the series.
    if (!firstMonth || keys[0] > firstMonth) firstMonth = keys[0];
    if (!lastMonth || keys[keys.length - 1] < lastMonth) lastMonth = keys[keys.length - 1];
  }
  if (!firstMonth || !lastMonth || firstMonth > lastMonth) return null;
  return { firstMonth, lastMonth };
}

/** First calendar day of a `YYYY-MM`, as ISO. */
const monthStart = (key: string): string => `${key}-01`;

// ──────────────────────────────────────────────────────────── findings

/**
 * Mechanical checks. Each of these was a judgement call made by hand during
 * the original analysis; all of them turn out to be rules.
 */
/** Where a market-weight figure came from, so the UI can say so. */
export interface MarketWeight {
  /** US share of global equity market capitalisation, as a fraction. */
  usEquity: number;
  /**
   * `YYYY-MM` the estimate is anchored to. Null when the figure carries no
   * date of its own: the fallback constant, and a user-supplied override
   * (we know the number they gave us, not the date they meant it for).
   */
  asOf: string | null;
  source: 'derived' | 'user' | 'fallback';
  /** Months of data behind a derived estimate. */
  months?: number;
}

/**
 * Used only when the benchmark data cannot support a derived estimate. This is
 * the figure `SPEC.md` quotes; it is roughly right for the mid-2020s and
 * materially wrong for earlier periods, which is precisely why it should not be
 * a constant.
 */
export const FALLBACK_US_MARKET_WEIGHT = 0.63;

/** Deviation from market weight, in percentage points, that counts as a tilt. */
export const REGIONAL_TILT_THRESHOLD = 0.15;

/**
 * Estimate the US share of global equity market capitalisation from the shipped
 * benchmark series.
 *
 * `GLOBAL_EQUITY` is cap-weighted, so over any window its return is
 * approximately `w * US_TOTAL + (1 - w) * INTL_TOTAL`. Least squares on
 * `g - i = w * (u - i)` recovers `w` without needing a market-cap source.
 *
 * This is inference from return correlation, NOT a sourced market-cap figure.
 * It is accurate to roughly a percentage point, which is fine for a threshold
 * check and would not be fine for anything quoted as a fact. Prefer index
 * factsheet weights if they are ever added to the data.
 *
 * The weight is anchored to `asOf` because it moves: it sat near 0.60 in 2022
 * and near 0.63 in 2025, and was near 0.37 in 2010. A single constant is wrong
 * over any long window.
 *
 * WHY THE WINDOW IS SHORT, AND WHY LONGER IS WORSE.
 * A regression returns the AVERAGE weight over its window, so a trailing window
 * lags the truth by roughly half its length. The weight drifts about 2pp a
 * year, so lengthening the window buys a little less estimator noise at the
 * cost of a lot more staleness. Measured on the shipped series:
 *
 *   anchored 2023-08:  12mo 0.608 | 24mo 0.600 | 36mo 0.598 | 60mo 0.577 | 120mo 0.552
 *   anchored 2026-07:  12mo 0.618 | 24mo 0.623 | 36mo 0.624 | 60mo 0.612 | 120mo 0.582
 *
 * 12 to 36 months agree closely; past that the estimate lags badly — at 120
 * months it returns roughly the 2018 weight for a 2026 date. This is the rare
 * estimator that gets WORSE as more history becomes available, which is exactly
 * what happened when the monthly series was extended back to 1996: a 60-month
 * default silently began answering a question about 2018.
 *
 * 24 is the default because it sits inside the stable band with a margin at
 * both ends, and because it still averages two full annual cycles.
 *
 * Returns null when fewer than 12 usable months precede `asOf`.
 */
/**
 * Trailing months used to estimate the market weight. See the note on
 * `impliedUsMarketWeight` — longer is not safer here.
 */
export const DEFAULT_MARKET_WEIGHT_WINDOW = 24;

export function impliedUsMarketWeight(
  data: BenchmarkData,
  asOf?: string,
  windowMonths = DEFAULT_MARKET_WEIGHT_WINDOW,
): MarketWeight | null {
  const g = data.monthly['GLOBAL_EQUITY'];
  const u = data.monthly['US_TOTAL'];
  const i = data.monthly['INTL_TOTAL'];
  if (!g || !u || !i) return null;

  let keys = Object.keys(g)
    .filter((k) => k in u && k in i)
    .sort();
  if (asOf) keys = keys.filter((k) => k <= asOf);
  keys = keys.slice(-windowMonths);
  if (keys.length < 12) return null;

  let num = 0;
  let den = 0;
  for (const k of keys) {
    const x = u[k] - i[k];
    num += x * (g[k] - i[k]);
    den += x * x;
  }
  if (den === 0) return null;

  const w = num / den;
  // Guard against a degenerate fit on thin or pathological data.
  if (!Number.isFinite(w) || w < 0.2 || w > 0.9) return null;

  return {
    usEquity: w,
    asOf: keys[keys.length - 1],
    source: 'derived',
    months: keys.length,
  };
}

export function deriveFindings(
  input: PortfolioInput,
  you: { xirr: number; annual: Record<string, number> },
  ref: StrategyResult,
  capture: AnalysisResult['capture'],
  marketWeight: MarketWeight,
  /**
   * Window metadata from `analyse`. Optional so existing callers keep working;
   * omitting it treats every period as a full year, which is the behaviour
   * before partial periods were tracked.
   */
  periods: Record<string, PeriodInfo> = {},
  /**
   * The date `currentAge` is stated as of. Only the target-year check uses it,
   * and only its UTC year. Defaulting to the wall clock keeps every existing
   * caller working; passing it explicitly is what makes this module as
   * deterministic as its docblock claims, because `currentAge` is an age
   * TODAY and the year it implies changes on 1 January whether or not the
   * input did.
   */
  now: Date = new Date(),
): Finding[] {
  const f: Finding[] = [];

  // 1. Target-date horizon mismatch
  if (input.currentAge && input.statedTargetYear) {
    const retireAge = input.statedTargetYear - (now.getUTCFullYear() - input.currentAge);
    if (retireAge < 60) {
      f.push({
        id: 'target-year-mismatch',
        severity: 'notable',
        title: `Your account's target year implies retiring at ${retireAge}`,
        detail:
          `A target year of ${input.statedTargetYear} means the glide path is being run for someone ` +
          `retiring at about ${retireAge}. If that is not your plan, the portfolio may be far more ` +
          `conservative than your actual horizon warrants. Worth confirming where that date came from.`,
      });
    }
  }

  // 2. Upside/downside capture asymmetry
  //
  // Full periods only. A stub period's return is the raw return over its own
  // (short) window, un-annualised, so its capture ratio is not commensurate
  // with a full year's and must not be averaged in alongside one. The stubs
  // stay in `you.annual` — the year-by-year visual renders all six periods and
  // footnotes the partial ones — they are excluded here and nowhere else.
  const years = Object.keys(you.annual).filter((y) => !periods[y]?.partial);
  const up = years.filter((y) => (ref.annual[y] ?? 0) > 0);
  const down = years.filter((y) => (ref.annual[y] ?? 0) < 0);
  if (up.length >= 2 && down.length >= 1) {
    const upCap = up.reduce((s, y) => s + you.annual[y] / ref.annual[y], 0) / up.length;
    const downCap = down.reduce((s, y) => s + you.annual[y] / ref.annual[y], 0) / down.length;
    if (downCap > 1 && upCap < 1) {
      f.push({
        id: 'capture-asymmetry',
        severity: 'notable',
        title: 'You captured less of the gains but more of the losses',
        detail:
          `Across up periods you captured about ${(upCap * 100).toFixed(0)}% of the reference return, ` +
          `but in down periods you absorbed about ${(downCap * 100).toFixed(0)}%. A genuinely more ` +
          `conservative portfolio would lag on the way up AND cushion on the way down. ` +
          (down.length === 1
            ? 'Note this rests on a single down period, so treat it as a question rather than a verdict.'
            : ''),
      });
    }
  }

  // 3. Fee explains only a minority of the gap
  if (capture.forgone > 0) {
    const feeShareOfGap = capture.feeShare / capture.forgone;
    if (input.feePct > 0 && feeShareOfGap < 0.5) {
      f.push({
        id: 'fee-minority',
        severity: 'info',
        title: 'The fee explains less than half the difference',
        detail:
          `Your fee accounts for roughly ${(feeShareOfGap * 100).toFixed(0)}% of the gap. ` +
          `The rest comes from the strategy itself — allocation, fund selection, or security choice. ` +
          `Negotiating the fee down would not close it.`,
      });
    }
  }

  // 4. Holdings deviate materially from market weight
  if (input.holdings) {
    const eq = input.holdings.positions.filter(
      (p) => p.assetClass === 'us_equity' || p.assetClass === 'intl_equity',
    );
    const total = eq.reduce((s, p) => s + p.value, 0);
    const us = eq.filter((p) => p.assetClass === 'us_equity').reduce((s, p) => s + p.value, 0);
    if (total > 0) {
      const usShare = us / total;
      const mw = marketWeight.usEquity;
      if (Math.abs(usShare - mw) > REGIONAL_TILT_THRESHOLD) {
        f.push({
          id: 'regional-tilt',
          severity: 'info',
          title: `Your equity is ${(usShare * 100).toFixed(0)}% US`,
          detail:
            `Global market weight is roughly ${(mw * 100).toFixed(0)}% US` +
            `${marketWeight.asOf ? ` as of ${marketWeight.asOf}` : ''}. ` +
            `A deviation this size is a deliberate bet on one region — it may pay off or ` +
            `not, but it is a choice someone made.`,
        });
      }
      const usEq = eq.filter((p) => p.assetClass === 'us_equity');
      const smid = usEq
        .filter((p) => p.sizeBucket === 'mid' || p.sizeBucket === 'small')
        .reduce((s, p) => s + p.value, 0);
      if (us > 0 && smid / us > 0.4) {
        f.push({
          id: 'size-tilt',
          severity: 'notable',
          title: `Mid and small cap are ${((smid / us) * 100).toFixed(0)}% of your US equity`,
          detail:
            `Market weight is roughly 27%. Tilting toward smaller companies is a recognised, ` +
            `academically supported strategy — but it is a bet, and it goes through long stretches ` +
            `of underperforming the broad market.`,
        });
      }
    }
  }

  // 5. Genuinely good result — the tool must be able to say this
  if (capture.forgone <= 0) {
    f.push({
      id: 'outperformed',
      severity: 'info',
      title: 'Your strategy beat the passive reference',
      detail:
        `Over this period you finished ahead of the reference strategy. Worth checking whether ` +
        `that came with more risk, and remembering that a few years is a short sample.`,
    });
  }

  return f;
}

// ──────────────────────────────────────────────────────── main entry

export function analyse(
  input: PortfolioInput,
  data: BenchmarkData,
  strategies: StrategyDef[],
  referenceId: string,
  /**
   * The date `input.currentAge` is stated as of. Threaded to `deriveFindings`
   * and used nowhere else. Defaults to the wall clock so callers need not care;
   * supply it to make the whole call reproducible.
   */
  now: Date = new Date(),
): AnalysisResult {
  const flows = input.rows
    .filter((r): r is Extract<InputRow, { type: 'contribution' | 'withdrawal' }> =>
      r.type === 'contribution' || r.type === 'withdrawal')
    .map((r) => ({
      date: toDate(r.date),
      amount: r.type === 'contribution' ? Math.abs(r.amount) : -Math.abs(r.amount),
    }))
    .sort((a, b) => a.date.getTime() - b.date.getTime());

  const balances = input.rows
    .filter((r) => r.type === 'balance')
    .map((r) => ({ date: toDate(r.date), value: r.amount }))
    .sort((a, b) => a.date.getTime() - b.date.getTime());

  // INTERACTION.md, "Error and edge states": fewer than two balance rows
  // cannot be computed, and the copy must explain the minimum — one starting
  // and one ending value. Note what is NOT required any more: contributions.
  // "No contributions" is a legitimate shape (see `openingPosition` below),
  // and the old combined guard rejected it.
  if (balances.length < 2) {
    throw new AnalysisError(
      'insufficient-balances',
      balances.length === 0
        ? 'No balance rows. An analysis needs at least two balances — one starting ' +
          'value and one ending value — so that there is a period to measure.'
        : `Only one balance row (dated ${balances[0].date.toISOString().slice(0, 10)}). ` +
          'An analysis needs at least two — one starting value and one ending value — ' +
          'so that there is a period to measure.',
      { balanceCount: balances.length },
    );
  }

  /**
   * Capital that was already invested when the history opens, as opposed to
   * contributed during it.
   *
   * THE RULE: the first balance is opening capital when it is dated before the
   * first flow. Otherwise zero.
   *
   * The input format already distinguishes these unambiguously — `balance`
   * means "the account was worth this", `contribution` means "I added this" —
   * so there is nothing here to guess at. A balance dated before any flow can
   * only be money that was already there. A balance dated after a contribution
   * already contains that contribution, so counting both would double-count
   * it, which is why the ordinary shape yields zero:
   *
   *   contribution first, balance later   -> 0 (the real fixture)
   *   balances only, no flows at all      -> the first balance
   *   first balance predates the first flow -> the first balance
   *
   * The no-flows case falls out of the same rule rather than being special:
   * with no flows there is no first flow for the balance to follow.
   *
   * This is NOT a synthetic contribution. It never enters `grossContributed`,
   * `netContributed` or `dataQuality.flowCount`, all of which keep reporting
   * what the user actually put in. It enters the return maths, where a
   * valuation-dated inflow is the correct and standard way to open a
   * money-weighted calculation, and it enters the capture framing as invested
   * capital rather than as gain.
   *
   * Zero and negative opening balances are excluded: an account opened but not
   * yet funded has no capital to measure a return on, and nothing should be
   * inferred from it either way.
   *
   * INTERACTION.md's "ask whether that's an opening balance; offer to convert
   * it" remains good UI guidance, and `dataQuality.balanceBeforeFirstFlow`
   * still carries the flag so the UI can ask. It is not a reason for the
   * engine to return a wrong answer while it waits to be asked.
   */
  const opensBeforeFirstFlow = flows.length === 0 || balances[0].date < flows[0].date;
  const openingPosition =
    opensBeforeFirstFlow && balances[0].value > 0 ? balances[0].value : 0;

  if (flows.length === 0 && openingPosition <= 0) {
    throw new AnalysisError(
      'no-invested-capital',
      'No contributions or withdrawals were entered and the first balance is ' +
        `${openingPosition}, so there is no invested capital to measure a return on. ` +
        'Add the contributions, or an opening balance greater than zero.',
    );
  }

  /**
   * The flows the RETURN maths runs on: the user's own, plus the opening
   * position when there is one. Everything the user is told they contributed
   * comes from `flows`, never from this.
   */
  const modelFlows = openingPosition > 0
    ? [{ date: balances[0].date, amount: openingPosition }, ...flows]
    : flows;

  const first = flows.length && flows[0].date < balances[0].date ? flows[0].date : balances[0].date;
  const last = balances[balances.length - 1].date;
  const endingValue = balances[balances.length - 1].value;
  const months = monthRange(ym(first), ym(last));

  // INTERACTION.md: "History predates benchmark coverage — name the earliest
  // supported date and offer to analyse the covered portion." Without this,
  // `buildStrategySeries` throws `missing monthly GLOBAL_EQUITY 2019-01` from
  // three frames down, which is a crash rather than an answer. The same guard
  // catches the other end of the window, which the table does not mention and
  // which fails identically: a history running to 2026-11 is just as far
  // outside the data as one starting in 2019.
  const coverage = benchmarkCoverage(data, strategies);
  if (coverage) {
    const earliestSupported = monthStart(coverage.firstMonth);
    const latestSupported = monthEnd(coverage.lastMonth);
    const firstIso = first.toISOString().slice(0, 10);
    const lastIso = last.toISOString().slice(0, 10);

    if (months[0] < coverage.firstMonth) {
      const covered = lastIso >= earliestSupported;
      throw new AnalysisError(
        'history-before-coverage',
        `This history starts ${firstIso}, before the benchmark data begins. The earliest ` +
          `supported date is ${earliestSupported}. ` +
          (covered
            ? `The part of it from ${earliestSupported} to ${lastIso} can be analysed.`
            : 'None of this history falls inside the supported range.'),
        {
          earliestSupported,
          latestSupported,
          coveredFrom: covered ? earliestSupported : null,
          coveredTo: covered ? lastIso : null,
        },
      );
    }
    if (months[months.length - 1] > coverage.lastMonth) {
      const covered = firstIso <= latestSupported;
      throw new AnalysisError(
        'history-after-coverage',
        `This history runs to ${lastIso}, past the end of the benchmark data. The latest ` +
          `supported date is ${latestSupported}. ` +
          (covered
            ? `The part of it from ${firstIso} to ${latestSupported} can be analysed.`
            : 'None of this history falls inside the supported range.'),
        {
          earliestSupported,
          latestSupported,
          coveredFrom: covered ? firstIso : null,
          coveredTo: covered ? latestSupported : null,
        },
      );
    }
  }

  const grossContributed = flows.filter((f) => f.amount > 0).reduce((s, f) => s + f.amount, 0);
  const grossWithdrawn = -flows.filter((f) => f.amount < 0).reduce((s, f) => s + f.amount, 0);
  const netContributed = grossContributed - grossWithdrawn;

  const yourCF = [...modelFlows.map((f) => ({ date: f.date, amount: -f.amount })),
                  { date: last, amount: endingValue }];
  const yourXirr = xirr(yourCF);

  // annual returns for the user, Modified Dietz
  const yourAnnual: Record<string, number> = {};
  // Window actually measured for each of those years. Recorded because the
  // first and last are typically stubs, and because the reference strategies
  // below must be compounded over exactly these windows to be comparable.
  const periods: Record<string, PeriodInfo> = {};
  const years = [...new Set(balances.map((b) => b.date.getUTCFullYear()))];
  for (const y of years) {
    const s = balances.filter((b) => b.date.getUTCFullYear() === y - 1).pop()
           ?? balances.find((b) => b.date.getUTCFullYear() === y);
    const e = balances.filter((b) => b.date.getUTCFullYear() === y).pop();
    if (!s || !e || s.date >= e.date) continue;
    const yf = flows.filter((f) => f.date > s.date && f.date <= e.date);
    yourAnnual[String(y)] = modifiedDietz(s.value, e.value, yf, s.date, e.date);
    const days = daysBetween(s.date, e.date);
    periods[String(y)] = {
      start: s.date.toISOString().slice(0, 10),
      end: e.date.toISOString().slice(0, 10),
      days,
      partial: days < FULL_PERIOD_DAYS,
    };
  }

  const results: StrategyResult[] = strategies.map((def) => {
    const series = buildStrategySeries(def, data, months);
    // The reference is given the same money on the same days, opening position
    // included — otherwise a lump-sum history would be compared against a
    // strategy that was never funded and would end at zero.
    const { path, ending } = replay(series, modelFlows, months);
    const cf = [...modelFlows.map((f) => ({ date: f.date, amount: -f.amount })),
                { date: last, amount: ending }];
    const ann: Record<string, number> = {};
    for (const [y, p] of Object.entries(periods)) {
      // Compound over the SAME window the user's Modified Dietz figure covers,
      // not over the whole calendar year. A month counts when its end falls in
      // (start, end]: the opening balance already reflects everything up to and
      // including `start`, so crediting the reference with the month that
      // closed on `start` would measure it over a period the user never held.
      // Full years are unaffected — a 2021-12-31 → 2022-12-31 window selects
      // exactly 2022-01…2022-12, which is what the calendar-year filter gave.
      // Monthly is the finest granularity the benchmark data has, so a window
      // boundary falling mid-month rounds to the whole month.
      let g = 1;
      for (const mk of months) {
        const me = monthEnd(mk);
        if (me > p.start && me <= p.end) g *= 1 + series[mk] / 100;
      }
      ann[y] = g - 1;
    }
    return {
      id: def.id, label: def.label, endingValue: ending, xirr: xirr(cf),
      vsYou: ending - endingValue, path, annual: ann,
    };
  });

  const ref = results.find((r) => r.id === referenceId) ?? results[0];
  /**
   * Capital the user put to work over the period: contributed during it, plus
   * anything already invested when it opened. Stripping this out is what makes
   * the capture bar mean "gain", per SPEC.md's default view — "contributions
   * stripped out, because you don't get credit for those".
   *
   * `openingPosition` is 0 for every history that has flows, so this is
   * `netContributed` exactly as before for all of them. It is non-zero only in
   * the lump-sum case, where leaving it out would count the entire opening
   * balance as available gain and report a capture percentage that is not
   * about performance at all.
   */
  const investedBase = netContributed + openingPosition;
  const available = ref.endingValue - investedBase;
  const kept = endingValue - investedBase;
  const forgone = available - kept;

  // fee share: what the same gross performance would have produced at 0.10%
  const feeDelta = Math.max(0, input.feePct - 0.001);
  const feeShare = feeDelta > 0
    ? (() => {
        const target = yourXirr + feeDelta;
        let lo = endingValue, hi = endingValue * 3;
        for (let i = 0; i < 200; i++) {
          const mid = (lo + hi) / 2;
          const r = xirr([...modelFlows.map((f) => ({ date: f.date, amount: -f.amount })),
                          { date: last, amount: mid }]);
          if (r < target) lo = mid; else hi = mid;
        }
        return (lo + hi) / 2 - endingValue;
      })()
    : 0;

  const capture = {
    available, kept, forgone,
    pctKept: available > 0 ? kept / available : NaN,
    pctForgone: available > 0 ? forgone / available : NaN,
    feeShare: Math.min(feeShare, Math.max(forgone, 0)),
    otherShare: Math.max(forgone, 0) - Math.min(feeShare, Math.max(forgone, 0)),
  };

  const you = { xirr: yourXirr, annual: yourAnnual };

  // Market weight for the regional-tilt check, in order of precedence:
  //   1. an explicit `usMarketWeight` from the user — a judgement input, so
  //      theirs wins, and it carries no date because we don't know what date
  //      they meant it for;
  //   2. a value derived from the benchmark series, anchored to the holdings
  //      date when there are holdings, because that is the date the comparison
  //      is actually about — comparing a 2023 snapshot against a 2026 weight
  //      would measure the market's drift as if it were the user's tilt;
  //   3. the fallback constant, when there is too little data to derive one.
  // `slice(0, 7)` rather than a Date round-trip: holdings dates are written
  // both as `YYYY-MM-DD` and as `YYYY-MM`, and this reads both. A mid-month
  // snapshot pulls in that whole month's return, which is immaterial to a
  // weight estimate.
  const holdingsMonth = input.holdings?.asOf.slice(0, 7);
  const marketWeight: MarketWeight =
    input.usMarketWeight != null
      ? { usEquity: input.usMarketWeight, asOf: null, source: 'user' }
      : impliedUsMarketWeight(data, holdingsMonth) ?? {
          usEquity: FALLBACK_US_MARKET_WEIGHT,
          asOf: null,
          source: 'fallback',
        };

  const findings = deriveFindings(input, you, ref, capture, marketWeight, periods, now);

  // Data quality is measured in MONTHS OBSERVED, not balance rows: two
  // balances inside one month are one month of evidence, and the span they sit
  // in is what the chart draws. `balanceCount` still reports rows, because
  // that is what the user typed and the two are worth being able to compare.
  const spanMonths = months.length;
  const observedMonthKeys = [...new Set(balances.map((b) => ym(b.date)))].sort();
  const observedMonths = observedMonthKeys.length;
  const monthIndex = (mk: string): number => {
    const [y, m] = mk.split('-').map(Number);
    return y * 12 + (m - 1);
  };
  let largestGapMonths = 0;
  for (let i = 1; i < observedMonthKeys.length; i++) {
    const gap = monthIndex(observedMonthKeys[i]) - monthIndex(observedMonthKeys[i - 1]);
    if (gap > largestGapMonths) largestGapMonths = gap;
  }
  const granularity = classifyGranularity(observedMonths, spanMonths);

  // INTERACTION.md: "Balance dated before first contribution — ask whether
  // that's an opening balance; offer to convert it." Both halves belong to the
  // UI, but it cannot ask what it has not been told, and until it asks, the
  // engine is measuring a return on capital it never saw arrive. Reported as a
  // date rather than a boolean so the question can name the row.
  const balanceBeforeFirstFlow =
    flows.length > 0 && balances[0].date < flows[0].date
      ? balances[0].date.toISOString().slice(0, 10)
      : null;

  const warnings = dataQualityWarnings({
    granularity,
    observedMonths,
    spanMonths,
    largestGapMonths,
    periods,
    balanceYears: [...new Set(balances.map((b) => b.date.getUTCFullYear()))],
    flowDates: flows.map((f) => f.date),
    openingPositionDate:
      openingPosition > 0 ? balances[0].date.toISOString().slice(0, 10) : null,
    hasFlows: flows.length > 0,
    balanceBeforeFirstFlow,
    firstFlowDate: flows.length ? flows[0].date.toISOString().slice(0, 10) : null,
  });

  return {
    netContributed, grossContributed, grossWithdrawn, endingValue,
    gain: endingValue - investedBase,
    openingPosition,
    you, periods, strategies: results, referenceId: ref.id, capture,
    flowFreeWindows: findFlowFreeWindows(balances, flows),
    findings,
    marketWeight,
    dataQuality: {
      balanceCount: balances.length,
      observedMonths,
      spanMonths,
      coverage: observedMonths / spanMonths,
      largestGapMonths,
      flowCount: flows.length,
      balanceBeforeFirstFlow,
      granularity,
      firstDate: first.toISOString().slice(0, 10),
      lastDate: last.toISOString().slice(0, 10),
      warnings,
    },
  };
}
