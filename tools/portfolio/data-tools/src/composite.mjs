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
    expectedWeight: [0.45, 0.75],
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

export const COMPOSITE_THRESHOLDS = {
  rmsBp: 25,       // monthly residual root-mean-square, basis points
  maxBp: 75,       // worst single month
  annualBp: 120,   // per-year compounded disagreement (same floor as reconciliation)
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

  const w = fitWeight(pairs);
  const residuals = pairs.map((p) => ({
    key: p.key,
    bp: (p.t - (w * p.a + (1 - w) * p.b)) * 100,
  }));
  const rms = Math.sqrt(residuals.reduce((s, r) => s + r.bp ** 2, 0) / residuals.length);
  const worst = [...residuals].sort((x, y) => Math.abs(y.bp) - Math.abs(x.bp)).slice(0, 5);

  // per-year implied weight and compounded disagreement at the pooled weight
  const byYear = groupByYear(target);
  const years = [];
  for (const year of [...byYear.keys()].sort((x, y) => x - y)) {
    const yp = pairs.filter((p) => p.key.startsWith(String(year)));
    if (!yp.length) continue;
    const wy = fitWeight(yp);
    const tComp = compound(yp.map((p) => p.t));
    const cComp = compound(yp.map((p) => w * p.a + (1 - w) * p.b));
    years.push({
      year,
      months: yp.length,
      impliedWeight: wy,
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
        message: `${r.key} is ${r.bp > 0 ? '+' : ''}${r.bp.toFixed(1)}bp away from ${aId}/${bId} at the fitted weight`,
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
