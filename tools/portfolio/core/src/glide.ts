/**
 * A constructed target-date reference, for any retirement year.
 *
 * ─────────────────────────────────────────────────────────────────────────
 * WHAT THIS IS, AND WHAT IT IS NOT
 *
 * It is NOT a fund's record. `benchmarks.json` carries exactly one real
 * target-date series — `TARGET_2060`, Vanguard's VTTSX — and only from
 * 2021-10. Someone retiring in 2035 measured against a 2060 fund is being
 * measured against a much more aggressive allocation than their own plan
 * default, and anyone whose history starts before 2021-10 gets no target-date
 * comparison at all.
 *
 * It IS the issuer's own published glide path applied to index return series
 * that already exist. Vanguard files, every January, the allocation of every
 * fund in its Target Retirement ladder. That ladder, read on one date, IS the
 * glide path: twelve funds at five-year intervals of "years to the target
 * year". `data/glide-path.json` holds nineteen of those dated cross-sections,
 * 2007 through 2025, each citing the accession number it was read from.
 * Interpolate across the ladder and you have an allocation for any retirement
 * year; step between cross-sections as calendar time advances and you have one
 * that respects the fact that Vanguard changed the path twice.
 *
 * ─────────────────────────────────────────────────────────────────────────
 * WHY THIS CONSTRUCTION IS LEGITIMATE WHERE ANOTHER ONE WAS REJECTED
 *
 * `benchmarks.json`'s notes record a constructed pre-2008 GLOBAL_EQUITY that
 * was built, measured to an rms of 18.2bp a month against the real VT, and
 * then deliberately not shipped — because its anchor weight was a least-squares
 * fit to VT's returns and could not be sourced anywhere. The rule that came out
 * of that is: a number you fitted is not a number you sourced.
 *
 * Nothing here is fitted. Every weight in `glide-path.json` was read out of a
 * filed prospectus. And unlike that case there is a ground truth to check
 * against: the real VTTSX exists from 2021-10, and the issuer publishes
 * calendar-year returns for the whole ladder. `data-tools/glide_reconcile.mjs`
 * runs both checks and prints the residuals in basis points.
 *
 * ─────────────────────────────────────────────────────────────────────────
 * THE APPROXIMATION, STATED PLAINLY
 *
 * The real funds hold six sleeves. This models three, because
 * `benchmarks.json` has three: US equity, international equity, and everything
 * else as `BOND_TOTAL`. US investment-grade bonds it has; short-term TIPS and
 * USD-hedged international bonds it does not, and both are real parts of a
 * near-retirement portfolio. The cost of that is measured rather than assumed,
 * and it is not uniform: against the issuer's published calendar-year returns
 * over 2016–2025 the constructed series reconciles to an rms of about 8bp a
 * year on the long-dated funds, which are almost all equity, and about 58bp a
 * year on a fund already past its target year, which is where the TIPS and
 * hedged-bond sleeves are largest. `targetDateStrategy` carries that in its
 * `caution` so the user is told, not just the file.
 */

import type { FundRef, StrategyDef } from './engine';

// ────────────────────────────────────────────────────────────── the table

/** One fund's allocation, at one date, on one schedule. */
export interface GlidePoint {
  /**
   * Years from the schedule's as-of date to 1 January of the fund's target
   * year. Positive before the target year, negative after it.
   */
  t: number;
  /** Percent of the portfolio in equities, US and international together. */
  equity: number;
  /** Percent of the EQUITY sleeve that is US. Not percent of the portfolio. */
  usEquityShare: number;
  /** Which fund in the ladder this point was read from. Provenance only. */
  fund: string;
}

/** The whole ladder, as the issuer stated it on one date. */
export interface GlideSchedule {
  /** ISO date the issuer's figures are as of. */
  asOf: string;
  /**
   * `composite` — the portion allocations Vanguard states its own composite
   * benchmark index is derived from, which is the target schedule itself.
   * `holdings` — the actual portfolio on the fiscal year end, which sits
   * inside the rebalancing band around that target rather than exactly on it.
   */
  basis: 'holdings' | 'composite';
  /** Index into `GlidePathData.sources`. */
  source: number;
  /** Ascending in `t`. */
  points: GlidePoint[];
}

/** Where one schedule came from. Every schedule has one; none is unsourced. */
export interface GlideSource {
  asOf: string;
  form: string;
  /** SEC accession number, the citation of record for this project. */
  accession: string;
  filed: string;
  url: string;
  /** Which disclosure inside the filing the numbers were read out of. */
  field: string;
}

export interface GlidePathData {
  meta: { version: string; generated: string; notes: string[]; [k: string]: unknown };
  sources: GlideSource[];
  schedules: GlideSchedule[];
}

/**
 * Which `benchmarks.json` series each sleeve maps to.
 *
 * Exported because `benchmarkCoverage` needs to know what a constructed
 * target-date reference will demand of the data before one is built — and
 * because it is the honest statement of what the three-sleeve approximation
 * is: everything that is not equity is US investment-grade bonds.
 */
export const TARGET_DATE_SERIES = {
  usEquity: 'US_TOTAL',
  intlEquity: 'INTL_TOTAL',
  fixedIncome: 'BOND_TOTAL',
} as const;

// ───────────────────────────────────────────────────────────── the maths

/**
 * A month key as a decimal year, measured at the month's last day.
 *
 * The glide path is a function of a continuous distance to the target year, so
 * the month has to become a number on the same axis the schedule's `t` is on.
 * Month END rather than start, because that is the point the month's return
 * has been earned to.
 */
export function decimalYearOfMonthEnd(monthKey: string): number {
  const [y, m] = monthKey.split('-').map(Number);
  const end = Date.UTC(y, m, 0);
  const jan = Date.UTC(y, 0, 1);
  const nextJan = Date.UTC(y + 1, 0, 1);
  return y + (end - jan) / (nextJan - jan);
}

/**
 * The schedule in force in a given month, and whether that is an extrapolation.
 *
 * "In force" means the latest schedule whose as-of date has passed. Before the
 * first schedule — 2007-01-29, the earliest annual prospectus the allocation
 * could be read out of — the first one is reused and `extrapolated` is true.
 * The funds launched 2003-10, `INTL_TOTAL` starts 2004-01, so the window that
 * flag covers is 2004-01 to 2007-01.
 */
export function scheduleFor(
  monthKey: string,
  table: GlidePathData,
): { schedule: GlideSchedule; extrapolated: boolean } {
  const monthEndish = `${monthKey}-31`;
  let picked = table.schedules[0];
  let found = false;
  for (const s of table.schedules) {
    if (s.asOf <= monthEndish) {
      picked = s;
      found = true;
    }
  }
  return { schedule: picked, extrapolated: !found };
}

/** Linear interpolation over a schedule's ladder, flat outside its range. */
function interpolate(points: GlidePoint[], t: number, key: 'equity' | 'usEquityShare'): number {
  const first = points[0];
  const last = points[points.length - 1];
  if (t <= first.t) return first[key];
  if (t >= last.t) return last[key];
  for (let i = 1; i < points.length; i++) {
    const a = points[i - 1];
    const b = points[i];
    if (t <= b.t) {
      const f = (t - a.t) / (b.t - a.t);
      return a[key] + f * (b[key] - a[key]);
    }
  }
  /* c8 ignore next -- unreachable: t < last.t was handled above */
  return last[key];
}

/**
 * The allocation a target-date fund for `retirementYear` would have held in
 * `monthKey`, as weights on the three series in `TARGET_DATE_SERIES`.
 *
 * Pure. Sums to 1. Flat outside the ladder in both directions: a retirement
 * year far enough out sits at the schedule's most aggressive point (90%
 * equity), and one far enough past sits at its Income allocation (30%), which
 * is what the real funds do.
 */
export function glideWeights(
  retirementYear: number,
  monthKey: string,
  table: GlidePathData,
): Record<string, number> {
  const { schedule } = scheduleFor(monthKey, table);
  const t = retirementYear - decimalYearOfMonthEnd(monthKey);
  const equity = interpolate(schedule.points, t, 'equity') / 100;
  const usShare = interpolate(schedule.points, t, 'usEquityShare') / 100;
  return {
    [TARGET_DATE_SERIES.usEquity]: equity * usShare,
    [TARGET_DATE_SERIES.intlEquity]: equity * (1 - usShare),
    [TARGET_DATE_SERIES.fixedIncome]: 1 - equity,
  };
}

// ────────────────────────────────────────────────────── the catalogue entry

/** The copy and costs a constructed target-date entry is built from. */
export interface TargetDateTemplate {
  /** `TARGET_DATE_2035` etc. is `${idPrefix}${retirementYear}`. */
  idPrefix: string;
  /** `{year}` is substituted. */
  labelTemplate: string;
  explainer: string;
  caution: string;
  /** The provenance sentence SPEC requires be visible wherever this shows. */
  constructed: string;
  /** Extra annual drag on top of the component series. See the note below. */
  expenseRatio: number;
  funds: FundRef[];
  /**
   * A picker list, not a limit — any whole year works. The five-year spacing
   * is the fund industry's convention, not a property of the maths.
   */
  suggestedYears?: number[];
  /**
   * Catalogue strategy id → the retirement year it is the REAL fund for.
   * `targetDateReferences` reads it.
   */
  preferReal?: Record<string, string>;
}

/**
 * Build a `StrategyDef` for a constructed target-date reference.
 *
 * The def's `weights` are static, as every other catalogue entry's are, and
 * hold the allocation as of the newest schedule — that is the figure a UI
 * should quote as "what this holds today", and it is what `embeddedExpenseRatio`
 * weights the component funds by. The allocation actually compounded is
 * `weightsAt`, which `buildStrategySeries` asks for month by month. The two
 * differ by well under a basis point of embedded cost across the whole path,
 * so nothing downstream of the expense-ratio maths is sensitive to the choice.
 *
 * `rebalance` is `monthly` because the target itself moves monthly; annual
 * rebalancing to a moving target would let the drift and the glide compound
 * against each other for eleven months at a time.
 *
 * On `expenseRatio` — the extra drag — the default is 0, as it is for every
 * other entry in the catalogue, and that is a measured choice rather than a
 * copied one. The component series are already net of their own funds' fees,
 * and those fees are not constant across the window: `benchmarks.json` uses
 * the ETF share classes from 2021-10 (about 4bp on this blend) and the older,
 * dearer investor mutual-fund classes before that (about 15bp). Vanguard's
 * real target-date funds charge 8bp. So adding drag to reach 8bp would be
 * right for the recent window and would double-count for the earlier one.
 * Reconciled against the issuer's published calendar-year returns for the whole
 * ladder over 2016–2025, a zero extra drag lands a mean of −5bp a year and a
 * drag topping the blend up to 8bp lands −9bp; zero is the better-calibrated
 * default. A user whose plan's target-date fund costs more says so through
 * `PortfolioInput.expenseRatios`, which is what `caution` tells them to do.
 */
export function targetDateStrategy(
  retirementYear: number,
  template: TargetDateTemplate,
  table: GlidePathData,
): StrategyDef {
  if (!Number.isInteger(retirementYear)) {
    throw new Error(`retirementYear must be a whole year, got ${retirementYear}`);
  }
  const newest = table.schedules[table.schedules.length - 1];
  const asOfMonth = newest.asOf.slice(0, 7);
  // Every `{year}`, not the first one. `String.replace` with a string pattern
  // substitutes a single occurrence, and both `explainer` and `caution` name
  // the year twice — so until the tool grew a field to type a retirement year
  // into, nothing rendered these strings and nothing caught it. The literal
  // text "{year}" reached the screen the first time one was offered.
  const year = (t: string) => t.replace(/\{year\}/g, String(retirementYear));
  return {
    id: `${template.idPrefix}${retirementYear}`,
    label: year(template.labelTemplate),
    weights: glideWeights(retirementYear, asOfMonth, table),
    weightsAt: (monthKey) => glideWeights(retirementYear, monthKey, table),
    expenseRatio: template.expenseRatio,
    funds: template.funds,
    rebalance: 'monthly',
    explainer: year(template.explainer),
    caution: year(template.caution),
    constructed: year(template.constructed),
  };
}


/**
 * The target-date references to offer for a stated retirement year — the real
 * fund first where one exists, then the constructed one.
 *
 * WHY BOTH RATHER THAN EITHER. Where a real fund's series exists it should be
 * preferred: it is a record rather than a model, it carries the fund's actual
 * cost and its actual sleeves, and it is the only thing the model was ever
 * checked against. But `TARGET_2060`'s data starts 2021-10, so selecting it
 * moves the supported window forward by seventeen years and can make a history
 * un-analysable that the constructed reference would have handled. So the
 * caller gets both, in preference order, and picks by what the history can
 * support — `benchmarkCoverage` on each def is the test.
 *
 * Showing the two side by side where both are available is also a fair thing
 * to do rather than a redundant one: the gap between them IS the model's
 * error, made visible on the user's own numbers instead of asserted in a
 * caution.
 */
export function targetDateReferences(
  retirementYear: number,
  template: TargetDateTemplate,
  table: GlidePathData,
  catalogue: StrategyDef[] = [],
): StrategyDef[] {
  const wanted = String(retirementYear);
  const real = Object.entries(template.preferReal ?? {})
    .filter(([, year]) => year === wanted)
    .map(([id]) => catalogue.find((s) => s.id === id))
    .filter((s): s is StrategyDef => s !== undefined);
  return [...real, targetDateStrategy(retirementYear, template, table)];
}
