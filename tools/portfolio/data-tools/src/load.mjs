// Loading and normalising benchmark / candidate return files.
// Offline only: reads the filesystem, never the network.

import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

const MONTH_KEY = /^(\d{4})-(\d{2})$/;
const YEAR_KEY = /^(\d{4})$/;

const MONTH_NAMES = [
  'jan', 'feb', 'mar', 'apr', 'may', 'jun',
  'jul', 'aug', 'sep', 'oct', 'nov', 'dec',
];

export function monthName(m) {
  return MONTH_NAMES[m - 1].replace(/^./, (c) => c.toUpperCase());
}

/**
 * Find duplicate keys inside JSON objects.
 *
 * JSON.parse silently keeps the LAST value for a duplicated key, so a file
 * containing `"2023-04": 1.0` twice parses cleanly and loses data with no
 * error anywhere. The only way to see it is to look at the raw text, so we
 * run a minimal scanner over the source before parsing.
 *
 * Returns [{ path, key }].
 */
export function findDuplicateKeys(text) {
  const dups = [];
  const stack = []; // { type: 'object'|'array', keys:Set, path:string, index:number }
  let i = 0;
  let pendingKey = null; // last string literal read at object depth, awaiting ':'

  const readString = () => {
    // assumes text[i] === '"'
    let out = '';
    i++;
    while (i < text.length) {
      const c = text[i];
      if (c === '\\') {
        out += text[i] + text[i + 1];
        i += 2;
        continue;
      }
      if (c === '"') {
        i++;
        return out;
      }
      out += c;
      i++;
    }
    return out;
  };

  while (i < text.length) {
    const c = text[i];
    if (c === '"') {
      const s = readString();
      // Is this a key? Only if we're directly inside an object and the next
      // non-whitespace character is a colon.
      let j = i;
      while (j < text.length && /\s/.test(text[j])) j++;
      const top = stack[stack.length - 1];
      if (top && top.type === 'object' && text[j] === ':') {
        if (top.keys.has(s)) dups.push({ path: top.path, key: s });
        top.keys.add(s);
        pendingKey = s;
      }
      continue;
    }
    if (c === '{' || c === '[') {
      const parent = stack[stack.length - 1];
      let path;
      if (!parent) path = '$';
      else if (parent.type === 'object') path = `${parent.path}.${pendingKey ?? '?'}`;
      else path = `${parent.path}[${parent.index}]`;
      if (parent && parent.type === 'array') parent.index++;
      stack.push({
        type: c === '{' ? 'object' : 'array',
        keys: new Set(),
        path,
        index: 0,
      });
      pendingKey = null;
      i++;
      continue;
    }
    if (c === '}' || c === ']') {
      stack.pop();
      i++;
      continue;
    }
    if (c === ',') {
      pendingKey = null;
      const top = stack[stack.length - 1];
      // count scalar array elements so array paths stay honest
      if (top && top.type === 'array') { /* index advanced on container open only */ }
    }
    i++;
  }
  return dups;
}

function looksLikeSeriesMap(obj) {
  if (!obj || typeof obj !== 'object' || Array.isArray(obj)) return null;
  const vals = Object.values(obj);
  if (vals.length === 0) return null;
  if (!vals.every((v) => v && typeof v === 'object' && !Array.isArray(v))) return null;
  const keys = vals.flatMap((v) => Object.keys(v));
  if (keys.length === 0) return null;
  if (keys.every((k) => MONTH_KEY.test(k))) return 'monthly';
  if (keys.every((k) => YEAR_KEY.test(k))) return 'annual';
  return 'mixed';
}

/**
 * Load a candidate file. Accepts:
 *   - a full benchmarks.json  ({ meta, annual, monthly })
 *   - a partial              ({ monthly: {...} } or { annual: {...} })
 *   - a bare series map      ({ US_500: { "1996-01": 3.4, ... } })
 *
 * `force` ('monthly' | 'annual') disambiguates a bare map if needed.
 */
export function loadCandidate(path, { force } = {}) {
  const abs = resolve(path);
  const text = readFileSync(abs, 'utf8');
  let parsed;
  try {
    parsed = JSON.parse(text);
  } catch (err) {
    throw new Error(`${path}: not valid JSON — ${err.message}`);
  }
  const duplicates = findDuplicateKeys(text);

  let meta = parsed.meta ?? null;
  let annual = parsed.annual ?? null;
  let monthly = parsed.monthly ?? null;
  // A "full" file is a complete benchmarks.json: both blocks present. Anything
  // else is a candidate fragment, and checks that assume completeness (which
  // series exist, coverage claims) must not be run against it.
  const shape = annual && monthly ? 'full' : 'partial';

  if (!annual && !monthly) {
    const kind = force ?? looksLikeSeriesMap(parsed);
    if (kind === 'monthly') monthly = parsed;
    else if (kind === 'annual') annual = parsed;
    else {
      throw new Error(
        `${path}: cannot tell what this file is. Expected { meta, annual, monthly }, ` +
        `or a bare { SERIES: { "YYYY-MM": n } } map. Use --as monthly|annual to force.`,
      );
    }
  }

  return {
    path: abs,
    label: path,
    text,
    shape,
    borrowedMeta: false,
    meta,
    annual: annual ?? {},
    monthly: monthly ?? {},
    duplicates,
  };
}

/** Parse a "YYYY-MM" key into { year, month } or null. */
export function parseMonthKey(k) {
  const m = MONTH_KEY.exec(k);
  if (!m) return null;
  const month = Number(m[2]);
  if (month < 1 || month > 12) return null;
  return { year: Number(m[1]), month };
}

/** Group a monthly series into { [year]: [{ key, month, value }] } in month order. */
export function groupByYear(series) {
  const out = new Map();
  for (const [key, value] of Object.entries(series)) {
    const p = parseMonthKey(key);
    if (!p) continue;
    if (!out.has(p.year)) out.set(p.year, []);
    out.get(p.year).push({ key, month: p.month, value });
  }
  for (const rows of out.values()) rows.sort((a, b) => a.month - b.month);
  return out;
}

/**
 * Read the YTD marker out of meta.coverage.annual, e.g.
 *   "1996-2026 (2026 = YTD through 31 Jul)"  ->  { year: 2026, throughMonth: 7 }
 * Returns null when the coverage string carries no YTD marker.
 */
export function parseYtdMarker(meta) {
  const s = meta?.coverage?.annual;
  if (typeof s !== 'string') return null;
  const m = /(\d{4})\s*=\s*YTD\s+through\s+(?:\d{1,2}\s+)?([A-Za-z]{3,})/i.exec(s);
  if (!m) return null;
  const idx = MONTH_NAMES.indexOf(m[2].slice(0, 3).toLowerCase());
  if (idx < 0) return null;
  return { year: Number(m[1]), throughMonth: idx + 1 };
}

/** Compound a list of percent returns. [3, -1] -> 1.97 (percent). */
export function compound(percents) {
  let acc = 1;
  for (const p of percents) acc *= 1 + p / 100;
  return (acc - 1) * 100;
}
