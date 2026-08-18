// Human-readable output. The audience is someone making a go/no-go call on a
// batch of newly sourced data, so: a table per series, a verdict per series,
// and the loudest thing on screen is the failure mode that matters most.

let USE_COLOR = process.stdout.isTTY && !process.env.NO_COLOR;
export function setColor(on) { USE_COLOR = on; }

const C = {
  reset: '\x1b[0m', bold: '\x1b[1m', dim: '\x1b[2m',
  red: '\x1b[31m', green: '\x1b[32m', yellow: '\x1b[33m',
  blue: '\x1b[34m', magenta: '\x1b[35m', cyan: '\x1b[36m',
};
const c = (code, s) => (USE_COLOR ? code + s + C.reset : String(s));
export const bold = (s) => c(C.bold, s);
export const dim = (s) => c(C.dim, s);
export const red = (s) => c(C.red, s);
export const green = (s) => c(C.green, s);
export const yellow = (s) => c(C.yellow, s);
export const cyan = (s) => c(C.cyan, s);

const STATUS_PAINT = {
  OK: green, WARN: yellow, FAIL: red, SKIP: dim,
  ERROR: red, INFO: dim,
};
export const paintStatus = (s) => (STATUS_PAINT[s] ?? ((x) => x))(s);

const visLen = (s) => String(s).replace(/\x1b\[[0-9;]*m/g, '').length;

export function table(headers, rows, align = []) {
  const all = [headers, ...rows];
  const widths = headers.map((_, i) => Math.max(...all.map((r) => visLen(r[i] ?? ''))));
  const pad = (s, w, a) => {
    const gap = w - visLen(s);
    return a === 'l' ? s + ' '.repeat(gap) : ' '.repeat(gap) + s;
  };
  const line = (r) => r.map((cell, i) => pad(cell ?? '', widths[i], align[i] ?? 'r')).join('  ');
  const out = [dim(line(headers)), dim(widths.map((w) => '─'.repeat(w)).join('  '))];
  for (const r of rows) out.push(line(r));
  return out.join('\n');
}

export function rule(title = '') {
  const w = 78;
  if (!title) return dim('─'.repeat(w));
  return dim('── ') + bold(title) + ' ' + dim('─'.repeat(Math.max(0, w - 4 - title.length)));
}

const fmtBp = (bp) => (bp === null || bp === undefined ? '—' : `${bp >= 0 ? '+' : ''}${bp.toFixed(1)}`);
const fmtPct = (p) => (p === null || p === undefined ? '—' : p.toFixed(2));

export function renderReconciliation(result) {
  const out = [];
  const { seriesId, rows, stats, priceOnly, status, thresholds, hasAnnual } = result;
  out.push('');
  out.push(`${bold(seriesId)}  ${paintStatus(status)}`);

  if (!hasAnnual) {
    const first = rows[0];
    const last = rows[rows.length - 1];
    out.push(dim(
      `  no annual series for ${seriesId} — compounding reconciliation is not available. ` +
      `Its only internal ground truth is the composite check below.`,
    ));
    if (first && last) {
      out.push(dim(`  monthly covers ${first.year}–${last.year}, ${rows.reduce((a, r) => a + r.monthCount, 0)} points.`));
    }
    return out.join('\n');
  }

  const body = rows.map((r) => {
    const months = String(r.monthCount);
    const paint = STATUS_PAINT[r.status] ?? ((x) => x);
    return [
      String(r.year),
      months,
      fmtPct(r.compounded),
      fmtPct(r.annual),
      r.diffBp === null ? '—' : paint(fmtBp(r.diffBp)),
      paint(r.status),
      dim(r.note ?? ''),
    ];
  });
  out.push(table(
    ['year', 'mths', 'monthly→', 'annual', 'diff bp', 'status', 'note'],
    body,
    ['l', 'r', 'r', 'r', 'r', 'l', 'l'],
  ));

  if (stats.n > 0) {
    out.push(dim(
      `  ${stats.n} comparable year(s) · median ${fmtBp(stats.median)}bp · mean ${fmtBp(stats.mean)}bp · ` +
      `sd ${stats.stdev === null ? '—' : stats.stdev.toFixed(1)}bp · max |${stats.maxAbs.toFixed(1)}|bp · ` +
      `${stats.negatives}/${stats.n} negative` +
      `  (warn >${thresholds.warnBp}bp, fail >${thresholds.failBp}bp)`,
    ));
  } else {
    out.push(dim('  no comparable years — nothing to reconcile against'));
  }

  if (priceOnly.verdict === 'PRICE_ONLY') {
    out.push('');
    out.push(red(bold('  ███ PRICE-ONLY SERIES SUSPECTED ███')));
    out.push(red(`  ${priceOnly.reason}`));
    out.push(red(
      `  Implied dividend yield ${priceOnly.impliedYieldPctPerYear.toFixed(2)}pp/yr` +
      (priceOnly.inCanonicalBand ? ' — squarely in the 1.5-4pp band SPEC warns about.' : '.'),
    ));
    out.push(red('  DO NOT COMMIT. Re-source this series on a total-return basis.'));
  } else if (priceOnly.verdict === 'SUSPECT') {
    out.push(yellow(`  ! directional bias: ${priceOnly.reason}`));
  } else if (priceOnly.verdict === 'CONSISTENT_POSITIVE_BIAS') {
    out.push(cyan(`  i ${priceOnly.reason}`));
  }
  return out.join('\n');
}

export function renderFindings(findings, title) {
  if (!findings.length) return `${title}: ${green('clean')}`;
  const out = [`${title}:`];
  const order = { ERROR: 0, WARN: 1, INFO: 2 };
  for (const f of [...findings].sort((a, b) => order[a.severity] - order[b.severity])) {
    out.push(`  ${paintStatus(f.severity)} ${dim(`[${f.code}]`)} ${f.where ? dim(f.where + ' — ') : ''}${f.message}`);
  }
  return out.join('\n');
}

export function renderComposite(r) {
  const out = [];
  out.push('');
  out.push(`${bold(r.target)} = ${r.components.join(' + ')}  ${paintStatus(r.status)}`);
  out.push(dim(`  ${r.rationale}`));
  if (!r.available) {
    out.push(dim(`  skipped: ${r.note}`));
    return out.join('\n');
  }
  out.push(dim(
    `  ${r.months} months, weight refitted on a rolling ${r.windowMonths}-month window: ` +
    `${r.components[0]} ${(r.weightFirst * 100).toFixed(1)}% -> ${(r.weightLast * 100).toFixed(1)}% ` +
    `(pooled ${(r.impliedWeight * 100).toFixed(1)}%)  ·  ` +
    `residual rms ${r.rmsBp.toFixed(1)}bp, max ${r.maxBp.toFixed(1)}bp`,
  ));
  out.push(table(
    ['year', 'mths', `implied ${r.components[0]}`, 'series', 'from parts', 'diff bp'],
    r.years.map((y) => [
      String(y.year),
      String(y.months),
      `${(y.impliedWeight * 100).toFixed(1)}%`,
      fmtPct(y.targetPct),
      fmtPct(y.compositePct),
      fmtBp(y.diffBp),
    ]),
    ['l', 'r', 'r', 'r', 'r', 'r'],
  ));
  for (const f of r.findings) {
    out.push(`  ${paintStatus(f.severity)} ${dim(`[${f.code}]`)} ${f.message}`);
  }
  return out.join('\n');
}

export function renderDiff(d, aLabel, bLabel, { maxRows = 20 } = {}) {
  const out = [];
  out.push('');
  out.push(`${bold(d.seriesId)}  ${d.counts.differing} of ${d.counts.compared} months disagree ` +
    `(> ${d.thresholds.toleranceBp}bp)` +
    (d.counts.alarms ? red(`  ${d.counts.alarms} ALARM`) : ''));
  if (d.rows.length) {
    // With a systematic difference every month disagrees and a 350-row table
    // buries the point. Show the largest disagreements, in date order.
    let shown = d.rows;
    let elided = 0;
    if (maxRows && d.rows.length > maxRows) {
      const keep = new Set([...d.rows]
        .sort((x, y) => Math.abs(y.bp ?? Infinity) - Math.abs(x.bp ?? Infinity))
        .slice(0, maxRows)
        .map((r) => r.key));
      shown = d.rows.filter((r) => keep.has(r.key));
      elided = d.rows.length - shown.length;
    }
    out.push(table(
      ['month', aLabel, bLabel, 'diff bp', ''],
      shown.map((r) => [
        r.key,
        r.a === null ? dim('—') : String(r.a),
        r.b === null ? dim('—') : String(r.b),
        r.bp === null ? '—' : (Math.abs(r.bp) > d.thresholds.alarmBp ? red(fmtBp(r.bp)) : yellow(fmtBp(r.bp))),
        r.kind === 'DIFF' ? '' : dim(r.kind),
      ]),
      ['l', 'r', 'r', 'r', 'l'],
    ));
    if (elided) out.push(dim(`  … ${elided} more disagreeing month(s) not shown (largest first; --all for every row)`));
  }
  if (d.yearRows.length) {
    out.push(dim('  compounded over shared months:'));
    out.push(table(
      ['year', 'mths', aLabel, bLabel, 'diff bp'],
      d.yearRows.map((y) => [
        String(y.year), String(y.months), fmtPct(y.a), fmtPct(y.b),
        Math.abs(y.diffBp) > 25 ? yellow(fmtBp(y.diffBp)) : fmtBp(y.diffBp),
      ]),
      ['l', 'r', 'r', 'r', 'r'],
    ));
  }
  if (d.systematic) {
    out.push(red(bold('  ███ SYSTEMATIC DISAGREEMENT ███')));
    out.push(red(`  ${d.systematic.message}`));
  }
  return out.join('\n');
}
