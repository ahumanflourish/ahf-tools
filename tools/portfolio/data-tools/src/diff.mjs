// Two-source diff.
//
// SPEC: "Always cross-check a new month against a second source before
// committing." This mode takes two candidate files and reports every month
// where they disagree, so the cross-check is a mechanical step rather than an
// eyeball.

import { compound, groupByYear } from './load.mjs';

export const DIFF_DEFAULTS = {
  toleranceBp: 2,  // published monthly figures round to 2dp = 1bp; 2bp allows for it
  alarmBp: 25,     // a disagreement this size is a sourcing error, not rounding
};

export function diffSeries(aSeries, bSeries, opts = {}) {
  const t = { ...DIFF_DEFAULTS, ...opts };
  const keys = [...new Set([...Object.keys(aSeries ?? {}), ...Object.keys(bSeries ?? {})])].sort();
  const rows = [];
  for (const key of keys) {
    const av = aSeries?.[key];
    const bv = bSeries?.[key];
    if (av === undefined && bv === undefined) continue;
    if (av === undefined) { rows.push({ key, a: null, b: bv, bp: null, kind: 'ONLY_B' }); continue; }
    if (bv === undefined) { rows.push({ key, a: av, b: null, bp: null, kind: 'ONLY_A' }); continue; }
    if (av === null || bv === null) {
      if (av !== bv) rows.push({ key, a: av, b: bv, bp: null, kind: 'NULL_MISMATCH' });
      continue;
    }
    const bp = (av - bv) * 100;
    if (Math.abs(bp) <= t.toleranceBp) continue;
    rows.push({ key, a: av, b: bv, bp, kind: Math.abs(bp) > t.alarmBp ? 'ALARM' : 'DIFF' });
  }

  const numeric = rows.filter((r) => r.bp !== null);
  const bps = numeric.map((r) => r.bp);
  const meanBp = bps.length ? bps.reduce((x, y) => x + y, 0) / bps.length : 0;
  const negatives = bps.filter((x) => x < 0).length;

  // A directional disagreement across many months is the same signature as
  // price-only: one source is on a different basis, not merely noisier.
  let systematic = null;
  if (bps.length >= 6) {
    const frac = Math.max(negatives, bps.length - negatives) / bps.length;
    if (frac >= 0.8 && Math.abs(meanBp) > 5) {
      const perYear = ((1 + meanBp / 10000) ** 12 - 1) * 100;
      systematic = {
        direction: meanBp > 0 ? 'A above B' : 'B above A',
        meanBp,
        impliedPerYearPct: perYear,
        message:
          `${Math.round(frac * 100)}% of disagreements point the same way, mean ` +
          `${meanBp > 0 ? '+' : ''}${meanBp.toFixed(1)}bp/month ≈ ${perYear > 0 ? '+' : ''}${perYear.toFixed(2)}pp/yr. ` +
          `This is a basis difference between the two sources, not sourcing noise. ` +
          `${Math.abs(perYear) >= 1.5 && Math.abs(perYear) <= 4 ? 'The magnitude is in the dividend-yield band — one of these is probably PRICE-ONLY.' : ''}`,
      };
    }
  }

  // Where both cover a full year, show what the disagreement costs annually.
  const yearRows = [];
  const ya = groupByYear(aSeries ?? {});
  const yb = groupByYear(bSeries ?? {});
  for (const year of [...new Set([...ya.keys(), ...yb.keys()])].sort((x, y) => x - y)) {
    const ra = ya.get(year) ?? [];
    const rb = yb.get(year) ?? [];
    const shared = ra.filter((r) => rb.some((s) => s.key === r.key && s.value != null) && r.value != null);
    if (shared.length < 2) continue;
    const av = compound(shared.map((r) => r.value));
    const bv = compound(shared.map((r) => rb.find((s) => s.key === r.key).value));
    yearRows.push({ year, months: shared.length, a: av, b: bv, diffBp: (av - bv) * 100 });
  }

  return {
    rows,
    yearRows,
    systematic,
    counts: {
      compared: keys.length,
      differing: rows.length,
      alarms: rows.filter((r) => r.kind === 'ALARM').length,
      onlyA: rows.filter((r) => r.kind === 'ONLY_A').length,
      onlyB: rows.filter((r) => r.kind === 'ONLY_B').length,
    },
    thresholds: t,
  };
}

export function diffCandidates(a, b, opts = {}) {
  const ids = [...new Set([...Object.keys(a.monthly), ...Object.keys(b.monthly)])].sort();
  const filter = opts.series ? new Set(opts.series) : null;
  return ids
    .filter((id) => !filter || filter.has(id))
    .map((id) => ({ seriesId: id, ...diffSeries(a.monthly[id], b.monthly[id], opts) }));
}
