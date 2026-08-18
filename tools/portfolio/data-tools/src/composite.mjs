// Cross-series sanity.
//
// Some series are, by construction, blends of others. GLOBAL_EQUITY is the
// world equity market — which is US_TOTAL plus INTL_TOTAL at market weights,
// and SPEC requires exactly that construction for anything before 2008 because
// no single fund existed. TARGET_2060 is a global equity/bond blend on a glide
// path.
//
// This check matters most precisely where the compounding check cannot help:
// GLOBAL_EQUITY, TARGET_2060 and CASH have no annual series to reconcile
// against, so the only internal ground truth available for them is their
// relationship to the series that DO have one.
//
// WHY THE WEIGHT IS FITTED ON A ROLLING WINDOW AND NOT POOLED.
//
// This check originally fitted ONE weight across the whole overlap. That was
// right for a 58-month window and wrong the moment the monthly data reached
// back to 2010, because the thing being fitted MOVES: the US share of world
// equity market capitalisation rose from 37.1% in 2010 to 62.8% in 2026. No
// single weight fits both ends, so a pooled fit reports the drift as error —
// it raised ERRORs on 2010, 2013, 2024 and 2025, years of untouched data, and
// the harness ended up flagging its own baseline. Pooled residual rms was
// 25.4bp with a worst annual disagreement of 162bp; refitting locally it is
// 16.7bp and 41bp.
//
// WHY ROLLING AND NOT A PER-YEAR REFIT, which is the obvious alternative.
//
// The per-year compounded disagreement is the ERROR-level test, and it is the
// only ground truth GLOBAL_EQUITY has. Fitting the weight on exactly the
// twelve months you then evaluate is circular: the fit absorbs whatever
// systematic error is in those months. Measured, on GLOBAL_EQUITY degraded to
// price-only at 2.2pp/yr — the degradation `verify.mjs demo` exists to catch —
// a per-year refit pulls 2011 down to -86bp and 2014 to -113bp, both INSIDE
// the 120bp fail floor the shipped harness used. Two of seventeen years would
// have gone quiet. An 18-month centred window shares only part of its span
// with the year under test, and leaves every one of those years at -134bp or
// worse. Rolling buys the drift tolerance without buying a false negative.

import { compound, groupByYear } from './load.mjs';

/**
 * Composites we know about. `expectedWeight` is the plausible range for the
 * first component's share; outside it, something is wrong with the data or the
 * series is not what it claims to be.
 */
export const COMPOSITES = [
  {
    target: 'GLOBAL_EQUITY',
    components: ['US_TOTAL', 'INTL_TOTAL'],
    // Widened from [0.45, 0.75]. This band is checked against the POOLED
    // weight, which over 2010-2026 is a time-average of a weight that really
    // did run from 37.1% to 62.8%; the old lower edge was set when the data
    // began in 2021 and would now reject the true history. It is still tight
    // enough to catch the case it exists for — GLOBAL_EQUITY pasted over with
    // a copy of US_TOTAL fits at 100%.
    expectedWeight: [0.30, 0.80],
    rationale:
      'World equity = US + non-US at market weights. SPEC requires GLOBAL_EQUITY ' +
      'to be CONSTRUCTED this way before 2008.',
  },
  {
    target: 'TARGET_2060',
    components: ['GLOBAL_EQUITY', 'BOND_TOTAL'],
    expectedWeight: [0.80, 1.0],
    rationale:
      'A 2060 target-date fund is still far from its glide-path landing, so it ' +
      'should sit near 90% equity through this window.',
  },
];

/**
 * All four derived from the shipped file under the rolling fit, not inherited.
 *
 * `windowMonths` — 18. The job is to track a weight that moves about 1.5pp a
 * year while still measuring a monthly return, so the window has to be long
 * enough that the fit is not noise and short enough that the drift inside it
 * is small. Measured across the range: 12 months gives a clean worst annual
 * of 82bp, 18 gives 41bp, 24 gives 51bp, 36 gives 71bp. 18 is the floor of
 * that curve. Windows are CENTRED and clamped at the ends of the series.
 *
 * `rmsBp` — 25, unchanged, and now with room underneath it: the residual rms
 * under the rolling fit is 16.7bp over 199 months (it was 25.4bp pooled,
 * i.e. sitting on the threshold).
 *
 * `maxBp` — 90, raised from 75. The largest single residual in the shipped
 * file is 77.4bp at 2012-01, where VT's market-price return (+5.47%) lagged
 * both of its own components (+5.08% US, +7.27% non-US). It is one month in
 * 199: p95 is 37bp, p99 is 69bp, and only three months exceed 60bp. The old
 * 75 was set against a 58-month window, and a longer window draws more tail
 * for the same distribution. 90 still fires on the degradation that matters —
 * a price-only GLOBAL_EQUITY reaches 102bp in its worst month.
 *
 * `annualBp` — 80, lowered from 120, and no longer tied to the reconciliation
 * fail floor. It was inheriting that number for want of a measurement of its
 * own; the rolling fit provides one. Clean, the worst annual disagreement in
 * the shipped file is 41bp. Degraded to price-only at 2.2pp/yr, the SMALLEST
 * annual disagreement is 134bp. 80 sits almost exactly between them, roughly
 * 2x above the noise and 1.7x below the signal. At the old 120 the margin on
 * the signal side was 14bp.
 */
export const COMPOSITE_THRESHOLDS = {
  windowMonths: 18,  // rolling fit window, centred, clamped at the ends
  rmsBp: 25,         // monthly residual root-mean-square, basis points
  maxBp: 90,         // worst single month
  annualBp: 80,      // per-year compounded disagreement
};

/** Least-squares w for target = w*a + (1-w)*b over the supplied months. */
export function fitWeight(pairs) {
  let num = 0;
  let den = 0;
  for (const { t, a, b } of pairs) {
    num += (t - b) * (a - b);
    den += (a - b) ** 2;
  }
  if (den === 0) return null;
  return num / den;
}

/**
 * A locally fitted weight for every month.
 *
 * `pairs` must be in ascending date order. Each month gets the least-squares
 * weight over the `window` months centred on it; near either end the window
 * slides inward rather than shrinking, so every fit is over the same number of
 * observations and the first and last weights are not noisier than the middle.
 * A window longer than the data degenerates to the pooled fit, which is the
 * right answer for a short series — TARGET_2060's 58 months barely drift.
 */
export function rollingWeights(pairs, window) {
  const n = pairs.length;
  const w = Math.max(2, Math.min(window, n));
  const out = new Array(n);
  for (let idx = 0; idx < n; idx++) {
    let hi = Math.min(n, Math.max(idx - (w >> 1), 0) + w);
    const lo = Math.max(0, hi - w);
    out[idx] = fitWeight(pairs.slice(lo, hi));
  }
  return out;
}

export function checkComposite(candidate, spec, thresholds = COMPOSITE_THRESHOLDS) {
  const t = { ...COMPOSITE_THRESHOLDS, ...thresholds };
  const [aId, bId] = spec.components;
  const target = candidate.monthly[spec.target];
  const a = candidate.monthly[aId];
  const b = candidate.monthly[bId];
  if (!target || !a || !b) {
    return {
      ...spec,
      available: false,
      note: `needs ${spec.target}, ${aId}, ${bId} in the monthly data`,
      status: 'SKIP',
      findings: [],
    };
  }

  const pairs = [];
  for (const key of Object.keys(target)) {
    const tv = target[key];
    const av = a[key];
    const bv = b[key];
    if (tv == null || av == null || bv == null) continue;
    pairs.push({ key, t: tv, a: av, b: bv });
  }
  if (pairs.length < 12) {
    return { ...spec, available: false, note: `only ${pairs.length} overlapping months`, status: 'SKIP', findings: [] };
  }

  // `pairs` is in ascending key order because `Object.keys` on the target
  // preserves insertion order and the structural check has already refused a
  // series whose keys do not ascend.
  pairs.sort((x, y) => (x.key < y.key ? -1 : x.key > y.key ? 1 : 0));

  // The POOLED weight, kept for one job only: the identity check. Asking "is
  // this series a world equity fund at all" is a question about the whole
  // window, and a series pasted over with one of its own components fits at
  // 100% pooled no matter how the window is sliced.
  const w = fitWeight(pairs);

  // Everything measured against the series — residuals, and the compounded
  // per-year disagreement — uses the LOCAL weight instead. See the note at the
  // top of this file for why this is not the same thing as a per-year refit.
  const local = rollingWeights(pairs, t.windowMonths);
  const modelled = pairs.map((p, idx) => local[idx] * p.a + (1 - local[idx]) * p.b);
  const residuals = pairs.map((p, idx) => ({ key: p.key, bp: (p.t - modelled[idx]) * 100 }));
  const rms = Math.sqrt(residuals.reduce((s, r) => s + r.bp ** 2, 0) / residuals.length);
  const worst = [...residuals].sort((x, y) => Math.abs(y.bp) - Math.abs(x.bp)).slice(0, 5);

  // Per-year compounded disagreement, the composite at its local weight
  // against the series itself. `impliedWeight` on each row is the year's OWN
  // least-squares fit — reported, never used to judge the year, because a
  // weight fitted on the twelve months it is then scored against absorbs
  // exactly the systematic error this check exists to find. It is here
  // because the drift is the interesting thing to look at.
  const byYear = groupByYear(target);
  const years = [];
  for (const year of [...byYear.keys()].sort((x, y) => x - y)) {
    const idxs = pairs.map((p, idx) => idx).filter((idx) => pairs[idx].key.startsWith(String(year)));
    if (!idxs.length) continue;
    const yp = idxs.map((idx) => pairs[idx]);
    const wy = fitWeight(yp);
    const tComp = compound(yp.map((p) => p.t));
    const cComp = compound(idxs.map((idx) => modelled[idx]));
    years.push({
      year,
      months: yp.length,
      impliedWeight: wy,
      fittedWeight: idxs.reduce((acc, idx) => acc + local[idx], 0) / idxs.length,
      targetPct: tComp,
      compositePct: cComp,
      diffBp: (tComp - cComp) * 100,
    });
  }

  const findings = [];
  if (w < spec.expectedWeight[0] || w > spec.expectedWeight[1]) {
    findings.push({
      severity: 'ERROR',
      code: 'IMPLIED_WEIGHT_OFF',
      message:
        `implied ${aId} weight is ${(w * 100).toFixed(1)}%, outside the expected ` +
        `${(spec.expectedWeight[0] * 100).toFixed(0)}-${(spec.expectedWeight[1] * 100).toFixed(0)}% band. ` +
        `${spec.target} may not be the series it claims to be.`,
      where: `monthly.${spec.target}`,
    });
  }
  if (rms > t.rmsBp) {
    findings.push({
      severity: 'WARN',
      code: 'COMPOSITE_RMS',
      message: `monthly residual rms ${rms.toFixed(1)}bp exceeds ${t.rmsBp}bp — ${spec.target} does not track its parts`,
      where: `monthly.${spec.target}`,
    });
  }
  for (const r of residuals) {
    if (Math.abs(r.bp) > t.maxBp) {
      findings.push({
        severity: 'WARN',
        code: 'COMPOSITE_MONTH',
        message: `${r.key} is ${r.bp > 0 ? '+' : ''}${r.bp.toFixed(1)}bp away from ${aId}/${bId} at the locally fitted weight`,
        where: `monthly.${spec.target}`,
      });
    }
  }
  for (const y of years) {
    if (Math.abs(y.diffBp) > t.annualBp) {
      findings.push({
        severity: 'ERROR',
        code: 'COMPOSITE_YEAR',
        message: `${y.year}: ${spec.target} compounds to ${y.targetPct.toFixed(2)}% but its parts give ${y.compositePct.toFixed(2)}% (${y.diffBp > 0 ? '+' : ''}${y.diffBp.toFixed(0)}bp)`,
        where: `monthly.${spec.target}`,
      });
    }
  }

  const status = findings.some((f) => f.severity === 'ERROR')
    ? 'FAIL'
    : findings.length ? 'WARN' : 'OK';

  return {
    ...spec,
    available: true,
    months: pairs.length,
    impliedWeight: w,
    windowMonths: Math.min(t.windowMonths, pairs.length),
    weightFirst: local[0],
    weightLast: local[local.length - 1],
    rmsBp: rms,
    maxBp: Math.max(...residuals.map((r) => Math.abs(r.bp))),
    worst,
    years,
    findings,
    status,
  };
}

export function checkComposites(candidate, thresholds) {
  return COMPOSITES.map((spec) => checkComposite(candidate, spec, thresholds));
}
