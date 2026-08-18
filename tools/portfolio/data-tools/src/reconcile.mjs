// Compounding reconciliation: do twelve monthly returns compound to the
// published annual return?
//
// This is the whole point of the harness. The shipped file carries 30 years of
// ANNUAL total return for the core series but only a recent window of MONTHLY
// data. Any backward extension of the monthly series therefore lands on top of
// an existing ground truth, and can be checked against it with no network and
// no second source.

import { compound, groupByYear, parseYtdMarker } from './load.mjs';

/** Default thresholds, in basis points of annual return. See docs/NOISE-FLOOR.md. */
export const DEFAULT_THRESHOLDS = {
  warnBp: 60,
  failBp: 120,
  // Price-only signature: consistently negative residual of dividend-yield size.
  priceOnlyMinBp: 100,
  priceOnlyMaxBp: 600,
  priceOnlyMinYears: 3,
  priceOnlyNegFraction: 0.8,
};

export const STATUS = { OK: 'OK', WARN: 'WARN', FAIL: 'FAIL', SKIP: 'SKIP' };

function median(xs) {
  if (xs.length === 0) return null;
  const s = [...xs].sort((a, b) => a - b);
  const mid = s.length >> 1;
  return s.length % 2 ? s[mid] : (s[mid - 1] + s[mid]) / 2;
}

function mean(xs) {
  return xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : null;
}

function stdev(xs) {
  if (xs.length < 2) return null;
  const m = mean(xs);
  return Math.sqrt(xs.reduce((a, b) => a + (b - m) ** 2, 0) / (xs.length - 1));
}

/** P(at least k of n same-sign) under a fair-coin null, two-sided. */
export function signTestP(k, n) {
  if (n === 0) return 1;
  const hits = Math.max(k, n - k);
  let logC = 0;
  let tail = 0;
  for (let j = 0; j <= n; j++) {
    if (j > 0) logC += Math.log(n - j + 1) - Math.log(j);
    if (j >= hits) tail += Math.exp(logC);
  }
  return Math.min(1, (tail * 2) / 2 ** n);
}

/**
 * Reconcile one series' monthly data against its annual data.
 *
 * Years fall into three buckets:
 *   - comparable: the monthly months present cover exactly the annual period
 *     (Jan-Dec, or Jan-through-M for a documented YTD year). Residual computed.
 *   - partial: monthly covers only part of the annual period (e.g. the first
 *     year of the monthly window). NOT an error; excluded from the residual
 *     statistics because comparing 3 months to a 12-month figure is meaningless.
 *   - unusable: annual value is null or missing.
 */
export function reconcileSeries(seriesId, monthlySeries, annualSeries, opts = {}) {
  const t = { ...DEFAULT_THRESHOLDS, ...(opts.thresholds ?? {}) };
  const ytd = opts.ytd ?? null;
  const byYear = groupByYear(monthlySeries ?? {});
  const rows = [];
  const allYears = [...byYear.keys()].sort((a, b) => a - b);
  const firstYear = allYears[0];
  const lastYear = allYears[allYears.length - 1];
  const hasAnnual = !!annualSeries && Object.keys(annualSeries).length > 0;

  for (const year of allYears) {
    const months = byYear.get(year);
    const values = months.map((m) => m.value);
    const annual = annualSeries ? annualSeries[String(year)] : undefined;

    const expectedThrough = ytd && ytd.year === year ? ytd.throughMonth : 12;
    const present = months.map((m) => m.month);
    const wanted = Array.from({ length: expectedThrough }, (_, i) => i + 1);
    const missing = wanted.filter((m) => !present.includes(m));
    const extra = present.filter((m) => m > expectedThrough);
    const hasNull = values.some((v) => v === null || v === undefined);

    const row = {
      year,
      monthCount: months.length,
      firstMonth: present[0],
      lastMonth: present[present.length - 1],
      missing,
      extra,
      annual: annual ?? null,
      compounded: null,
      diffBp: null,
      geomBp: null,
      status: STATUS.SKIP,
      note: '',
    };

    if (annual === null || annual === undefined) {
      row.note = annual === null ? 'annual value is null' : 'no annual figure for this year';
      rows.push(row);
      continue;
    }
    if (hasNull) {
      row.note = 'monthly series contains null';
      rows.push(row);
      continue;
    }
    if (missing.length > 0 || extra.length > 0) {
      const leadingTruncation =
        year === firstYear && missing.every((m) => m < row.firstMonth);
      const trailingTruncation =
        year === lastYear && missing.every((m) => m > row.lastMonth);
      row.truncated = leadingTruncation || trailingTruncation;
      if (extra.length) {
        row.note = `months beyond the annual period (${extra.join(', ')})`;
      } else if (leadingTruncation) {
        row.note = `monthly window starts ${months[0].key} — partial year, not comparable`;
      } else if (trailingTruncation) {
        row.note = `monthly window ends ${months[months.length - 1].key} — partial year, not comparable`;
      } else {
        row.note = `${missing.length} month(s) MISSING (${missing.join(',')}) — interior gap, not just a short window`;
        row.gap = true;
      }
      rows.push(row);
      continue;
    }

    row.compounded = compound(values);
    row.diffBp = (row.compounded - annual) * 100;
    // Geometric residual: the ratio of the two growth factors. This is the
    // scale-free version, and it is the one that matters for price-only
    // detection — a 200bp arithmetic shortfall on a +25% year and on a -18%
    // year are the same dividend yield, but different arithmetic numbers.
    row.geomBp = ((1 + row.compounded / 100) / (1 + annual / 100) - 1) * 1e4;
    const abs = Math.abs(row.diffBp);
    row.status = abs > t.failBp ? STATUS.FAIL : abs > t.warnBp ? STATUS.WARN : STATUS.OK;
    if (expectedThrough !== 12) row.note = `YTD through month ${expectedThrough}`;
    rows.push(row);
  }

  const comparable = rows.filter((r) => r.diffBp !== null);
  const resid = comparable.map((r) => r.diffBp);
  const geom = comparable.map((r) => r.geomBp);
  const negatives = resid.filter((r) => r < 0).length;
  const stats = {
    n: resid.length,
    geomMedian: median(geom),
    geomMean: mean(geom),
    mean: mean(resid),
    median: median(resid),
    stdev: stdev(resid),
    maxAbs: resid.length ? Math.max(...resid.map(Math.abs)) : null,
    negatives,
    negFraction: resid.length ? negatives / resid.length : null,
    signTestP: resid.length ? signTestP(negatives, resid.length) : null,
  };

  const priceOnly = detectPriceOnly(stats, t);

  let status = STATUS.OK;
  if (resid.length === 0) status = STATUS.SKIP;
  if (rows.some((r) => r.status === STATUS.WARN)) status = STATUS.WARN;
  if (rows.some((r) => r.status === STATUS.FAIL)) status = STATUS.FAIL;
  if (priceOnly.verdict === 'PRICE_ONLY') status = STATUS.FAIL;
  else if (priceOnly.verdict === 'SUSPECT') status = STATUS.WARN;

  // An interior gap is a defect, not merely an uncomparable year.
  if (rows.some((r) => r.gap)) status = STATUS.FAIL;

  return { seriesId, rows, stats, priceOnly, status, thresholds: t, hasAnnual };
}

/**
 * Price-only detection.
 *
 * A price-return series understates a total-return series by approximately the
 * dividend yield: persistently, in one direction, and by 1.5-4pp/yr for broad
 * equity indices. Random sourcing noise is symmetric and small. So the tell is
 * not magnitude alone but magnitude PLUS sign consistency, and both are needed
 * to distinguish it from a single bad year.
 */
export function detectPriceOnly(stats, t = DEFAULT_THRESHOLDS) {
  const out = {
    verdict: 'NONE',
    reason: '',
    impliedYieldPctPerYear: null,
    inCanonicalBand: false,
  };
  if (!stats.n || stats.n < t.priceOnlyMinYears) {
    out.reason = `too few comparable years (${stats.n ?? 0}) to judge`;
    return out;
  }
  // geometric where available; arithmetic is a close stand-in for synthetic stats
  const med = stats.geomMedian ?? stats.median;
  const consistent = stats.negFraction >= t.priceOnlyNegFraction;
  out.impliedYieldPctPerYear = -med / 100;

  if (consistent && -med >= t.priceOnlyMinBp && -med <= t.priceOnlyMaxBp) {
    out.verdict = 'PRICE_ONLY';
    // SPEC's band is 1.5-4pp/yr. The residual we measure is that yield NET of
    // any pre-existing basis offset between the monthly and annual share
    // classes (~+0.15pp in the shipped file), so allow a little slack at both
    // edges rather than making the flag knife-edge.
    out.inCanonicalBand = -med >= 130 && -med <= 430;
    out.reason =
      `${stats.negatives}/${stats.n} years fall SHORT of the annual total return, ` +
      `median shortfall ${(-med).toFixed(1)}bp (${(-med / 100).toFixed(2)}pp/yr). ` +
      `That is the shape of a dividend yield, not of noise ` +
      `(sign-consistency p=${stats.signTestP.toExponential(1)}).`;
    return out;
  }
  if (consistent && -med > t.warnBp) {
    out.verdict = 'SUSPECT';
    out.reason =
      `${stats.negatives}/${stats.n} years fall short, median ${(-med).toFixed(1)}bp. ` +
      `Consistent in sign but outside the dividend-yield band — check the basis.`;
    return out;
  }
  if (stats.negFraction <= 1 - t.priceOnlyNegFraction && med > t.warnBp) {
    out.verdict = 'CONSISTENT_POSITIVE_BIAS';
    out.reason =
      `${stats.n - stats.negatives}/${stats.n} years come in ABOVE the annual figure, ` +
      `median +${med.toFixed(1)}bp. Not price-only (wrong sign) but a systematic basis ` +
      `difference — check share class and expense ratio.`;
    return out;
  }
  out.reason = `median ${med.toFixed(1)}bp over ${stats.n} years, ${stats.negatives} negative — no directional signature`;
  return out;
}

/**
 * Empirical noise floor: pool residuals across every series that has an
 * overlap, and describe the distribution. This is how the tolerance is
 * justified rather than guessed.
 */
export function noiseFloor(candidate, opts = {}) {
  const ytd = parseYtdMarker(candidate.meta);
  const perSeries = [];
  const pooled = [];
  const pooledGeom = [];
  for (const seriesId of Object.keys(candidate.monthly)) {
    const annual = candidate.annual[seriesId];
    if (!annual) continue;
    const r = reconcileSeries(seriesId, candidate.monthly[seriesId], annual, { ...opts, ytd });
    const resid = r.rows.filter((x) => x.diffBp !== null).map((x) => x.diffBp);
    if (!resid.length) continue;
    perSeries.push({ seriesId, resid, geom: r.rows.filter((x) => x.geomBp !== null).map((x) => x.geomBp), stats: r.stats, rows: r.rows });
    pooled.push(...resid);
    pooledGeom.push(...r.rows.filter((x) => x.geomBp !== null).map((x) => x.geomBp));
  }
  return {
    perSeries,
    pooled,
    pooledGeom,
    geom: {
      mean: mean(pooledGeom),
      median: median(pooledGeom),
      stdev: stdev(pooledGeom),
      maxAbs: pooledGeom.length ? Math.max(...pooledGeom.map(Math.abs)) : null,
    },
    n: pooled.length,
    mean: mean(pooled),
    median: median(pooled),
    stdev: stdev(pooled),
    maxAbs: pooled.length ? Math.max(...pooled.map(Math.abs)) : null,
    p95: pooled.length
      ? [...pooled].map(Math.abs).sort((a, b) => a - b)[Math.min(pooled.length - 1, Math.ceil(0.95 * pooled.length) - 1)]
      : null,
  };
}
