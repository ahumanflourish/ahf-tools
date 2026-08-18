// Deliberate corruption of good data.
//
// A checker that has never caught anything is not evidence of anything. These
// helpers take the real shipped series and break it in each of the ways the
// sourcing work is actually likely to break it. They drive both the test suite
// and `verify.mjs demo`, which an operator can run at any time to confirm the
// alarms still fire before trusting a green report.

/** Deep clone of a loaded candidate so degradations don't leak between tests. */
export function clone(candidate) {
  return {
    ...candidate,
    meta: candidate.meta ? JSON.parse(JSON.stringify(candidate.meta)) : null,
    annual: JSON.parse(JSON.stringify(candidate.annual)),
    monthly: JSON.parse(JSON.stringify(candidate.monthly)),
    duplicates: [...candidate.duplicates],
  };
}

/**
 * Turn a total-return series into a price-only one.
 *
 * (1 + r_price) = (1 + r_total) / (1 + y)^(1/12)
 *
 * so that twelve degraded months compound to exactly `yieldPct` below the
 * true annual total return. This is what a source that quietly serves price
 * returns looks like.
 */
export function makePriceOnly(series, yieldPct) {
  const drag = (1 + yieldPct / 100) ** (1 / 12);
  const out = {};
  for (const [k, v] of Object.entries(series)) {
    out[k] = v === null ? null : round((((1 + v / 100) / drag) - 1) * 100);
  }
  return out;
}

/** Remove a month from the middle of the window. */
export function dropMonth(series, key) {
  const out = { ...series };
  if (!(key in out)) throw new Error(`dropMonth: ${key} not present`);
  delete out[key];
  return out;
}

/** Change one month by `deltaPct` percentage points. */
export function perturbMonth(series, key, deltaPct) {
  if (!(key in series)) throw new Error(`perturbMonth: ${key} not present`);
  return { ...series, [key]: round(series[key] + deltaPct) };
}

export function setMonth(series, key, value) {
  return { ...series, [key]: value };
}

/** Rewrite keys so they no longer ascend. */
export function shuffleKeys(series, aKey, bKey) {
  const entries = Object.entries(series);
  const ai = entries.findIndex(([k]) => k === aKey);
  const bi = entries.findIndex(([k]) => k === bKey);
  if (ai < 0 || bi < 0) throw new Error('shuffleKeys: missing key');
  [entries[ai], entries[bi]] = [entries[bi], entries[ai]];
  return Object.fromEntries(entries);
}

/**
 * Emit JSON TEXT containing a literally duplicated key. This cannot be done
 * with an object — JSON.parse keeps the last value and the collision vanishes
 * — which is exactly why the scanner has to look at the raw source.
 */
export function jsonWithDuplicateKey(candidate, seriesId, key) {
  const text = JSON.stringify({ meta: candidate.meta, annual: candidate.annual, monthly: candidate.monthly }, null, 1);
  const needle = `"${key}": `;
  const seriesStart = text.indexOf(`"${seriesId}": {`, text.indexOf('"monthly": {'));
  if (seriesStart < 0) throw new Error(`series ${seriesId} not found`);
  const at = text.indexOf(needle, seriesStart);
  if (at < 0) throw new Error(`key ${key} not found in ${seriesId}`);
  const lineEnd = text.indexOf('\n', at);
  const line = text.slice(at, lineEnd);
  const dup = line.endsWith(',') ? line : line + ',';
  return text.slice(0, at) + dup + '\n ' + text.slice(at);
}

/** Deterministic small symmetric noise — the control case that must NOT alarm. */
export function addNoise(series, bpPerMonth, seed = 1) {
  let s = seed >>> 0;
  const rnd = () => {
    s = (s * 1664525 + 1013904223) >>> 0;
    return s / 2 ** 32;
  };
  const out = {};
  for (const [k, v] of Object.entries(series)) {
    out[k] = v === null ? null : round(v + (rnd() - 0.5) * 2 * (bpPerMonth / 100));
  }
  return out;
}

const round = (x) => Math.round(x * 1e4) / 1e4;
