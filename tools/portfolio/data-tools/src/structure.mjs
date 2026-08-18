// Structural integrity: the checks that catch a series that is malformed
// rather than merely wrong.

import { parseMonthKey, parseYtdMarker } from './load.mjs';

export const SEVERITY = { ERROR: 'ERROR', WARN: 'WARN', INFO: 'INFO' };

/** Plausible bounds on a single period's return, in percent. */
export const BOUNDS = {
  monthly: { min: -40, max: 40 },
  annual: { min: -70, max: 150 },
};

/**
 * Series-specific monthly bounds. The generic +/-40% band is wide enough to
 * catch a units error but not wide enough to be useful for a bond or cash
 * series, where a plausible-looking number can still be obviously wrong.
 */
export const SERIES_MONTHLY_BOUNDS = {
  BOND_TOTAL: { min: -12, max: 12 },
  CASH: { min: -0.05, max: 1.5 },
};

function monthlyBounds(seriesId) {
  return SERIES_MONTHLY_BOUNDS[seriesId] ?? BOUNDS.monthly;
}

const err = (code, message, where) => ({ severity: SEVERITY.ERROR, code, message, where });
const warn = (code, message, where) => ({ severity: SEVERITY.WARN, code, message, where });
const info = (code, message, where) => ({ severity: SEVERITY.INFO, code, message, where });

function documentedNull(meta, seriesId, key) {
  const notes = meta?.notes;
  if (!Array.isArray(notes)) return false;
  const year = String(key).slice(0, 4);
  return notes.some((n) => {
    if (typeof n !== 'string') return false;
    return n.includes(seriesId) && (n.includes(year) || /null|no .* year|do not synthesise/i.test(n));
  });
}

export function checkStructure(candidate) {
  const findings = [];
  const { meta, annual, monthly } = candidate;
  // When meta was borrowed from another file (`--annual`), its coverage strings
  // describe that file, not this one, so testing them here proves nothing.
  const coverageIsAboutThisFile = !candidate.borrowedMeta;

  for (const d of candidate.duplicates) {
    findings.push(err(
      'DUPLICATE_KEY',
      `duplicate key "${d.key}" — JSON.parse keeps the LAST one and silently drops the other`,
      d.path,
    ));
  }

  // ---- monthly series ----
  for (const [seriesId, series] of Object.entries(monthly)) {
    const where = `monthly.${seriesId}`;
    const keys = Object.keys(series);
    if (keys.length === 0) {
      findings.push(err('EMPTY_SERIES', 'series has no data points', where));
      continue;
    }
    const parsed = [];
    for (const k of keys) {
      const p = parseMonthKey(k);
      if (!p) {
        findings.push(err('BAD_KEY', `key "${k}" is not a valid YYYY-MM month`, where));
        continue;
      }
      parsed.push({ key: k, ...p, ord: p.year * 12 + p.month, value: series[k] });
    }
    if (parsed.length === 0) continue;

    // chronological order as written in the file
    for (let i = 1; i < parsed.length; i++) {
      if (parsed[i].ord <= parsed[i - 1].ord) {
        findings.push(err(
          'NOT_CHRONOLOGICAL',
          `"${parsed[i].key}" appears after "${parsed[i - 1].key}"`,
          where,
        ));
      }
    }

    const sorted = [...parsed].sort((a, b) => a.ord - b.ord);
    // gaps
    for (let i = 1; i < sorted.length; i++) {
      const gap = sorted[i].ord - sorted[i - 1].ord;
      if (gap === 0) {
        findings.push(err('DUPLICATE_MONTH', `"${sorted[i].key}" appears twice`, where));
      } else if (gap > 1) {
        findings.push(err(
          'GAP',
          `${gap - 1} month(s) missing between "${sorted[i - 1].key}" and "${sorted[i].key}"`,
          where,
        ));
      }
    }

    // values
    for (const p of sorted) {
      if (p.value === null || p.value === undefined) {
        const fn = documentedNull(meta, seriesId, p.key) ? info : err;
        findings.push(fn(
          'NULL_VALUE',
          documentedNull(meta, seriesId, p.key)
            ? `null at ${p.key} — documented in meta.notes`
            : `null at ${p.key} with nothing in meta.notes explaining it`,
          where,
        ));
        continue;
      }
      if (typeof p.value !== 'number' || !Number.isFinite(p.value)) {
        findings.push(err('NON_NUMERIC', `${p.key} = ${JSON.stringify(p.value)}`, where));
        continue;
      }
      const mb = monthlyBounds(seriesId);
      if (p.value < mb.min || p.value > mb.max) {
        findings.push(err(
          'OUT_OF_RANGE',
          `${p.key} = ${p.value}% is outside the plausible monthly band for ${seriesId} ` +
          `[${mb.min}, ${mb.max}] — a decimal-place or units error?`,
          where,
        ));
      }
      if (Number.isInteger(p.value) && Math.abs(p.value) > 1 && sorted.length > 12) {
        // not an error, just worth an eye: whole-number returns are rare
        // and are what a units mistake looks like
      }
    }

    // pre-inception monthly data. This is the check that fires when someone
    // extends a constructed series backwards without saying so.
    const inceptionM = meta?.inception?.[seriesId];
    if (typeof inceptionM === 'number' && sorted.length && sorted[0].year < inceptionM) {
      const note = (meta?.notes ?? []).find((n) => typeof n === 'string' && n.includes(seriesId));
      findings.push(err(
        'PRE_INCEPTION_DATA',
        `monthly data starts ${sorted[0].key} but meta.inception says ${seriesId} began in ` +
        `${inceptionM}. If this is a CONSTRUCTED series it must be declared as such and the ` +
        `construction checked against its components` +
        (note ? ` (meta.notes says: "${note.slice(0, 90)}...")` : ' — and meta.notes says nothing about it'),
        where,
      ));
    }

    // coverage claim
    if (coverageIsAboutThisFile && meta?.coverage?.monthly) {
      const claim = String(meta.coverage.monthly);
      const first = sorted[0].key;
      const last = sorted[sorted.length - 1].key;
      if (!claim.includes(first) || !claim.includes(last)) {
        findings.push(warn(
          'COVERAGE_MISMATCH',
          `meta.coverage.monthly says "${claim}" but ${seriesId} actually runs ${first} → ${last}`,
          where,
        ));
      }
    }
  }

  // ---- annual series ----
  for (const [seriesId, series] of Object.entries(annual)) {
    const where = `annual.${seriesId}`;
    const years = [];
    for (const k of Object.keys(series)) {
      if (!/^\d{4}$/.test(k)) {
        findings.push(err('BAD_KEY', `key "${k}" is not a valid YYYY year`, where));
        continue;
      }
      years.push({ key: k, year: Number(k), value: series[k] });
    }
    for (let i = 1; i < years.length; i++) {
      if (years[i].year <= years[i - 1].year) {
        findings.push(err('NOT_CHRONOLOGICAL', `"${years[i].key}" after "${years[i - 1].key}"`, where));
      }
    }
    const sorted = [...years].sort((a, b) => a.year - b.year);
    for (let i = 1; i < sorted.length; i++) {
      const gap = sorted[i].year - sorted[i - 1].year;
      if (gap === 0) findings.push(err('DUPLICATE_YEAR', `"${sorted[i].key}" appears twice`, where));
      else if (gap > 1) findings.push(err('GAP', `${gap - 1} year(s) missing after ${sorted[i - 1].key}`, where));
    }
    for (const y of sorted) {
      if (y.value === null || y.value === undefined) {
        const ok = documentedNull(meta, seriesId, y.key);
        findings.push((ok ? info : err)(
          'NULL_VALUE',
          ok
            ? `null at ${y.key} — documented in meta.notes`
            : `null at ${y.key} with nothing in meta.notes explaining it`,
          where,
        ));
        continue;
      }
      if (typeof y.value !== 'number' || !Number.isFinite(y.value)) {
        findings.push(err('NON_NUMERIC', `${y.key} = ${JSON.stringify(y.value)}`, where));
      } else if (y.value < BOUNDS.annual.min || y.value > BOUNDS.annual.max) {
        findings.push(err('OUT_OF_RANGE', `${y.key} = ${y.value}% is outside [${BOUNDS.annual.min}, ${BOUNDS.annual.max}]`, where));
      }
    }

    // inception claim
    const inception = meta?.inception?.[seriesId];
    if (typeof inception === 'number' && sorted.length) {
      const firstWithData = sorted.find((y) => y.value !== null && y.value !== undefined);
      if (firstWithData && firstWithData.year < inception) {
        findings.push(err(
          'PRE_INCEPTION_DATA',
          `${seriesId} has a ${firstWithData.year} figure but meta.inception says the fund ` +
          `started in ${inception}. Either the data is synthesised or the inception is wrong.`,
          where,
        ));
      }
    }

    if (coverageIsAboutThisFile && meta?.coverage?.annual) {
      const claim = String(meta.coverage.annual);
      const first = String(sorted[0].year);
      const last = String(sorted[sorted.length - 1].year);
      if (!claim.includes(first) || !claim.includes(last)) {
        findings.push(warn(
          'COVERAGE_MISMATCH',
          `meta.coverage.annual says "${claim}" but ${seriesId} runs ${first} → ${last}`,
          where,
        ));
      }
    }
  }

  // ---- YTD marker sanity ----
  const ytd = parseYtdMarker(meta);
  if (meta?.coverage?.annual && !ytd) {
    findings.push(info(
      'NO_YTD_MARKER',
      `meta.coverage.annual carries no "YYYY = YTD through <Mon>" marker, so the final ` +
      `annual year cannot be reconciled against a partial monthly year.`,
      'meta.coverage.annual',
    ));
  }

  return { findings, ytd };
}

/** Every series id a strategy references must actually exist in the monthly data. */
export function checkStrategyReferences(candidate, strategies) {
  const findings = [];
  if (!strategies?.strategies) return findings;
  const have = new Set(Object.keys(candidate.monthly));
  for (const s of strategies.strategies) {
    for (const id of Object.keys(s.weights ?? {})) {
      if (!have.has(id)) {
        findings.push(err(
          'MISSING_SERIES',
          `strategy "${s.id}" references series "${id}" which is not in the monthly data`,
          'strategies.json',
        ));
      }
    }
    const total = Object.values(s.weights ?? {}).reduce((a, b) => a + b, 0);
    if (Math.abs(total - 1) > 1e-9) {
      findings.push(err('WEIGHTS_NOT_UNITY', `strategy "${s.id}" weights sum to ${total}`, 'strategies.json'));
    }
  }

  // Orphans: a monthly series nothing references, with no annual counterpart
  // and no composite relationship, cannot be checked by anything in this
  // harness and cannot be wrong in a way anyone would notice.
  const used = new Set(strategies.strategies.flatMap((s) => Object.keys(s.weights ?? {})));
  const composed = new Set(['US_TOTAL', 'INTL_TOTAL', 'GLOBAL_EQUITY', 'BOND_TOTAL', 'TARGET_2060']);
  for (const id of have) {
    if (used.has(id) || composed.has(id)) continue;
    if (candidate.annual?.[id]) continue;
    findings.push(warn(
      'UNVERIFIABLE_SERIES',
      `"${id}" has no annual counterpart, takes part in no composite, and no strategy ` +
      `references it. Nothing in this harness — or in the tool — can tell whether it is ` +
      `right. Either wire it up or drop it.`,
      `monthly.${id}`,
    ));
  }
  return findings;
}
