/**
 * Portfolio vs. Strategy — computational core.
 *
 * Pure functions. No DOM, no network, no framework. Everything here is
 * deterministic and unit-testable against fixtures.json.
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
  gain: number;
  you: { xirr: number; annual: Record<string, number> };
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
  dataQuality: {
    balanceCount: number;
    flowCount: number;
    granularity: 'annual' | 'monthly' | 'sparse';
    firstDate: string;
    lastDate: string;
    warnings: string[];
  };
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

// ──────────────────────────────────────────────────────────── findings

/**
 * Mechanical checks. Each of these was a judgement call made by hand during
 * the original analysis; all of them turn out to be rules.
 */
export function deriveFindings(
  input: PortfolioInput,
  you: { xirr: number; annual: Record<string, number> },
  ref: StrategyResult,
  capture: AnalysisResult['capture'],
): Finding[] {
  const f: Finding[] = [];

  // 1. Target-date horizon mismatch
  if (input.currentAge && input.statedTargetYear) {
    const retireAge = input.statedTargetYear - (new Date().getUTCFullYear() - input.currentAge);
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
  const years = Object.keys(you.annual);
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
      if (Math.abs(usShare - 0.63) > 0.15) {
        f.push({
          id: 'regional-tilt',
          severity: 'info',
          title: `Your equity is ${(usShare * 100).toFixed(0)}% US`,
          detail:
            `Global market weight is roughly 63% US. A deviation this size is a deliberate bet ` +
            `on one region — it may pay off or not, but it is a choice someone made.`,
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

  if (!flows.length || !balances.length) {
    throw new Error('Need at least one contribution and one balance.');
  }

  const first = flows[0].date < balances[0].date ? flows[0].date : balances[0].date;
  const last = balances[balances.length - 1].date;
  const endingValue = balances[balances.length - 1].value;
  const months = monthRange(ym(first), ym(last));

  const grossContributed = flows.filter((f) => f.amount > 0).reduce((s, f) => s + f.amount, 0);
  const grossWithdrawn = -flows.filter((f) => f.amount < 0).reduce((s, f) => s + f.amount, 0);
  const netContributed = grossContributed - grossWithdrawn;

  const yourCF = [...flows.map((f) => ({ date: f.date, amount: -f.amount })),
                  { date: last, amount: endingValue }];
  const yourXirr = xirr(yourCF);

  // annual returns for the user, Modified Dietz
  const yourAnnual: Record<string, number> = {};
  const years = [...new Set(balances.map((b) => b.date.getUTCFullYear()))];
  for (const y of years) {
    const s = balances.filter((b) => b.date.getUTCFullYear() === y - 1).pop()
           ?? balances.find((b) => b.date.getUTCFullYear() === y);
    const e = balances.filter((b) => b.date.getUTCFullYear() === y).pop();
    if (!s || !e || s.date >= e.date) continue;
    const yf = flows.filter((f) => f.date > s.date && f.date <= e.date);
    yourAnnual[String(y)] = modifiedDietz(s.value, e.value, yf, s.date, e.date);
  }

  const results: StrategyResult[] = strategies.map((def) => {
    const series = buildStrategySeries(def, data, months);
    const { path, ending } = replay(series, flows, months);
    const cf = [...flows.map((f) => ({ date: f.date, amount: -f.amount })),
                { date: last, amount: ending }];
    const ann: Record<string, number> = {};
    for (const y of Object.keys(yourAnnual)) {
      let g = 1;
      for (const mk of months.filter((m) => m.startsWith(y))) g *= 1 + series[mk] / 100;
      ann[y] = g - 1;
    }
    return {
      id: def.id, label: def.label, endingValue: ending, xirr: xirr(cf),
      vsYou: ending - endingValue, path, annual: ann,
    };
  });

  const ref = results.find((r) => r.id === referenceId) ?? results[0];
  const available = ref.endingValue - netContributed;
  const kept = endingValue - netContributed;
  const forgone = available - kept;

  // fee share: what the same gross performance would have produced at 0.10%
  const feeDelta = Math.max(0, input.feePct - 0.001);
  const feeShare = feeDelta > 0
    ? (() => {
        const target = yourXirr + feeDelta;
        let lo = endingValue, hi = endingValue * 3;
        for (let i = 0; i < 200; i++) {
          const mid = (lo + hi) / 2;
          const r = xirr([...flows.map((f) => ({ date: f.date, amount: -f.amount })),
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
  const findings = deriveFindings(input, you, ref, capture);

  const spanMonths = months.length;
  const granularity: 'annual' | 'monthly' | 'sparse' =
    balances.length >= spanMonths * 0.8 ? 'monthly'
    : balances.length >= spanMonths / 12 ? 'annual' : 'sparse';

  const warnings: string[] = [];
  if (granularity === 'sparse') {
    warnings.push(
      'You have fewer balance points than years covered. Annual returns will be rough. ' +
      'Adding year-end balances will sharpen this considerably.');
  }
  if (!flows.some((f) => f.date.getUTCDate() !== 15)) {
    warnings.push(
      'All contributions appear to be dated mid-month, which usually means dates were estimated. ' +
      'Real transaction dates will improve accuracy.');
  }

  return {
    netContributed, grossContributed, grossWithdrawn, endingValue,
    gain: endingValue - netContributed,
    you, strategies: results, referenceId: ref.id, capture,
    flowFreeWindows: findFlowFreeWindows(balances, flows),
    findings,
    dataQuality: {
      balanceCount: balances.length, flowCount: flows.length, granularity,
      firstDate: first.toISOString().slice(0, 10),
      lastDate: last.toISOString().slice(0, 10),
      warnings,
    },
  };
}
