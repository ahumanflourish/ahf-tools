#!/usr/bin/env node
// verify-benchmarks — offline verification harness for benchmark return data.
//
// NO NETWORK. This tool reads local JSON files and does arithmetic. That is a
// deliberate property, not an accident: the whole reason it exists is that
// remote sources were unreliable and one of them silently served price-only
// returns. Nothing here should ever be given the ability to fetch.

import { existsSync, readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { loadCandidate, parseYtdMarker } from './src/load.mjs';
import { DEFAULT_THRESHOLDS, STATUS, noiseFloor, reconcileSeries } from './src/reconcile.mjs';
import { checkStrategyReferences, checkStructure } from './src/structure.mjs';
import { checkComposites } from './src/composite.mjs';
import { diffCandidates } from './src/diff.mjs';
import {
  addNoise, clone, dropMonth, makePriceOnly, perturbMonth, setMonth, shuffleKeys,
} from './src/degrade.mjs';
import * as R from './src/report.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const DEFAULT_BENCHMARKS = join(HERE, '..', 'core', 'src', 'data', 'benchmarks.json');
const DEFAULT_STRATEGIES = join(HERE, '..', 'core', 'src', 'data', 'strategies.json');

const USAGE = `
verify-benchmarks — offline checks on benchmark return data

  check <file>                  full report: structure, compounding, price-only,
                                composites. Exit 1 on FAIL.
  noise-floor <file>            residual distribution over the overlap window,
                                used to justify the tolerance.
  diff <fileA> <fileB>          every month where two sources disagree.
  demo <file>                   break the good data on purpose and show the
                                checker catching each fault. Run this when you
                                want evidence the alarms still work.

Options
  --series ID[,ID]      restrict to these series
  --annual <file>       take the annual ground truth from a different file
                        (use when <file> is a monthly-only candidate)
  --strategies <file>   strategies.json to cross-check series references
                        (default: ../core/src/data/strategies.json)
  --as monthly|annual   force the shape of a bare series map
  --warn-bp N           per-year residual warn threshold   (default ${DEFAULT_THRESHOLDS.warnBp})
  --fail-bp N           per-year residual fail threshold   (default ${DEFAULT_THRESHOLDS.failBp})
  --tolerance-bp N      diff: ignore disagreements under N  (default 2)
  --alarm-bp N          diff: flag disagreements over N     (default 25)
  --all                 diff: print every disagreeing month, not just the worst
  --strict              treat WARN as failure (exit 1)
  --json                machine-readable output
  --no-color            plain text

Files default to ${DEFAULT_BENCHMARKS.replace(process.cwd() + '/', '')}
`;

function parseArgs(argv) {
  const out = { _: [], flags: {} };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (!a.startsWith('--')) { out._.push(a); continue; }
    const [k, inline] = a.slice(2).split('=');
    const boolish = ['strict', 'json', 'no-color', 'help', 'all'];
    if (boolish.includes(k)) { out.flags[k] = true; continue; }
    out.flags[k] = inline !== undefined ? inline : argv[++i];
  }
  return out;
}

function num(v, dflt) {
  if (v === undefined) return dflt;
  const n = Number(v);
  if (!Number.isFinite(n)) throw new Error(`expected a number, got "${v}"`);
  return n;
}

function readJson(path) {
  return JSON.parse(readFileSync(path, 'utf8'));
}

// ---------------------------------------------------------------- check ----

export function runCheck(candidate, opts = {}) {
  const thresholds = {
    ...DEFAULT_THRESHOLDS,
    warnBp: opts.warnBp ?? DEFAULT_THRESHOLDS.warnBp,
    failBp: opts.failBp ?? DEFAULT_THRESHOLDS.failBp,
  };
  const structure = checkStructure(candidate);
  const ytd = structure.ytd ?? parseYtdMarker(candidate.meta);

  const filter = opts.series ? new Set(opts.series) : null;
  const seriesIds = Object.keys(candidate.monthly).filter((id) => !filter || filter.has(id));

  const reconciliations = seriesIds.map((id) =>
    reconcileSeries(id, candidate.monthly[id], candidate.annual[id], { thresholds, ytd }));

  const composites = checkComposites(candidate).filter((r) => !filter || filter.has(r.target));

  // Only meaningful against a complete file: a candidate fragment holding one
  // newly sourced series is not missing the others, it just isn't them.
  const strategyFindings = opts.strategies && candidate.shape === 'full' && !filter
    ? checkStrategyReferences(candidate, opts.strategies)
    : [];

  const allFindings = [...structure.findings, ...strategyFindings];
  const hasStructuralError = allFindings.some((f) => f.severity === 'ERROR');
  const hasStructuralWarn = allFindings.some((f) => f.severity === 'WARN');
  const worstRecon = reconciliations.reduce(
    (acc, r) => (r.status === STATUS.FAIL ? STATUS.FAIL : r.status === STATUS.WARN && acc !== STATUS.FAIL ? STATUS.WARN : acc),
    STATUS.OK,
  );
  const compFail = composites.some((r) => r.status === 'FAIL');
  const compWarn = composites.some((r) => r.status === 'WARN');

  let verdict = STATUS.OK;
  if (hasStructuralWarn || worstRecon === STATUS.WARN || compWarn) verdict = STATUS.WARN;
  if (hasStructuralError || worstRecon === STATUS.FAIL || compFail) verdict = STATUS.FAIL;

  const priceOnlySeries = reconciliations
    .filter((r) => r.priceOnly.verdict === 'PRICE_ONLY')
    .map((r) => r.seriesId);

  return { candidate, structure, findings: allFindings, reconciliations, composites, verdict, priceOnlySeries, thresholds };
}

function printCheck(res, opts) {
  const lines = [];
  lines.push(R.rule('SOURCE'));
  lines.push(`  ${res.candidate.label}`);
  if (res.candidate.annualFrom) {
    lines.push(R.dim(`  annual ground truth${res.candidate.borrowedMeta ? ' and meta' : ''} from ${res.candidate.annualFrom}`));
  }
  if (res.candidate.shape === 'partial') lines.push(R.dim('  candidate fragment — completeness checks not applicable'));
  if (res.candidate.meta?.generated) lines.push(R.dim(`  meta: generated ${res.candidate.meta.generated}  ·  basis: ${res.candidate.meta.basis ?? 'unstated'}`));
  lines.push('');
  lines.push(R.rule('STRUCTURAL INTEGRITY'));
  lines.push(R.renderFindings(res.findings, '  keys, gaps, ranges, nulls, coverage claims'));
  lines.push('');
  lines.push(R.rule('COMPOUNDING RECONCILIATION'));
  lines.push(R.dim('  twelve monthly returns must compound to the published annual figure.'));
  lines.push(R.dim(`  tolerance: warn >${res.thresholds.warnBp}bp, fail >${res.thresholds.failBp}bp — see docs/NOISE-FLOOR.md`));
  for (const r of res.reconciliations) lines.push(R.renderReconciliation(r));
  lines.push('');
  lines.push(R.rule('CROSS-SERIES / COMPOSITES'));
  for (const r of res.composites) lines.push(R.renderComposite(r));
  lines.push('');
  lines.push(R.rule('VERDICT'));
  const counts = res.reconciliations.reduce((a, r) => { a[r.status] = (a[r.status] ?? 0) + 1; return a; }, {});
  lines.push('  ' + Object.entries(counts).map(([k, v]) => `${R.paintStatus(k)} ${v}`).join('   ') + R.dim('  (series)'));
  if (res.priceOnlySeries.length) {
    lines.push('  ' + R.red(R.bold(`PRICE-ONLY SUSPECTED: ${res.priceOnlySeries.join(', ')}`)));
  }
  const gate = res.verdict === STATUS.FAIL || (opts.strict && res.verdict === STATUS.WARN);
  lines.push(`  overall: ${R.paintStatus(res.verdict)}${gate ? R.red('  → NO-GO') : R.green('  → GO')}`);
  console.log(lines.join('\n'));
  return gate ? 1 : 0;
}

// ----------------------------------------------------------- noise floor ----

function printNoiseFloor(candidate, opts) {
  const nf = noiseFloor(candidate, { thresholds: { ...DEFAULT_THRESHOLDS, warnBp: 1e9, failBp: 1e9 } });
  if (opts.json) { console.log(JSON.stringify(nf, null, 2)); return 0; }
  const lines = [];
  lines.push(R.rule('EMPIRICAL NOISE FLOOR'));
  lines.push(R.dim('  Residual = (monthly compounded) − (published annual), in basis points,'));
  lines.push(R.dim('  over every year where the monthly window covers the annual period exactly.'));
  lines.push('');
  for (const s of nf.perSeries) {
    lines.push(`  ${R.bold(s.seriesId.padEnd(12))} n=${String(s.stats.n).padStart(2)}  ` +
      `median ${s.stats.median.toFixed(1).padStart(7)}  mean ${s.stats.mean.toFixed(1).padStart(7)}  ` +
      `sd ${(s.stats.stdev ?? 0).toFixed(1).padStart(6)}  max|${s.stats.maxAbs.toFixed(1)}|  ` +
      R.dim(s.resid.map((r) => r.toFixed(0)).join(' ')));
  }
  lines.push('');
  lines.push(`  ${R.bold('POOLED')}       n=${nf.n}  median ${nf.median.toFixed(1)}  mean ${nf.mean.toFixed(1)}  ` +
    `sd ${nf.stdev.toFixed(1)}  p95|${nf.p95.toFixed(1)}|  max|${nf.maxAbs.toFixed(1)}|`);
  lines.push(R.dim(`  (geometric, used for price-only detection:  median ${nf.geom.median.toFixed(1)}  ` +
    `mean ${nf.geom.mean.toFixed(1)}  sd ${nf.geom.stdev.toFixed(1)}  max|${nf.geom.maxAbs.toFixed(1)}|)`));
  lines.push('');
  const suggestWarn = Math.ceil((Math.abs(nf.mean) + 4 * nf.stdev) / 10) * 10;
  const suggestFail = suggestWarn * 2;
  lines.push(`  suggested warn threshold: ${R.bold(String(suggestWarn) + 'bp')}  (|mean| + 4sd, rounded up)`);
  lines.push(`  suggested fail threshold: ${R.bold(String(suggestFail) + 'bp')}  (2x warn; still below the 150bp`);
  lines.push(`                                       bottom edge of the dividend-yield band)`);
  lines.push(`  shipped defaults:         warn ${DEFAULT_THRESHOLDS.warnBp}bp / fail ${DEFAULT_THRESHOLDS.failBp}bp`);
  console.log(lines.join('\n'));
  return 0;
}

// ----------------------------------------------------------------- diff ----

function printDiff(a, b, opts) {
  const results = diffCandidates(a, b, {
    series: opts.series,
    toleranceBp: opts.toleranceBp,
    alarmBp: opts.alarmBp,
  });
  if (opts.json) { console.log(JSON.stringify(results, null, 2)); return 0; }
  const lines = [];
  lines.push(R.rule('TWO-SOURCE DIFF'));
  lines.push(`  A = ${a.label}`);
  lines.push(`  B = ${b.label}`);
  lines.push(R.dim(`  ignoring disagreements ≤ ${opts.toleranceBp ?? 2}bp (published figures round to 2dp)`));
  let bad = 0;
  for (const d of results) {
    if (d.counts.differing === 0 && !opts.verbose) {
      lines.push(`\n${R.bold(d.seriesId)}  ${R.green('identical within tolerance')} (${d.counts.compared} months)`);
      continue;
    }
    lines.push(R.renderDiff(d, 'A', 'B', { maxRows: opts.all ? 0 : 20 }));
    if (d.counts.alarms > 0 || d.systematic || d.counts.onlyA || d.counts.onlyB) bad++;
  }
  lines.push('');
  lines.push(R.rule('VERDICT'));
  lines.push(bad
    ? '  ' + R.red(`${bad} series need${bad === 1 ? 's' : ''} resolution before either source can be committed`)
    : '  ' + R.green('sources agree within tolerance'));
  console.log(lines.join('\n'));
  return bad ? 1 : 0;
}

// ----------------------------------------------------------------- demo ----

// Each case degrades the clean file in one specific way and states what the
// checker is expected to say about it. If any case comes back clean, the
// harness is broken and every green report it has ever produced is worthless.
const DEMO_CASES = [
  {
    name: 'price-only US_500 at 2.2pp/yr',
    why: 'the failure mode SPEC warns about: a source quietly serving price returns',
    apply: (c) => { c.monthly.US_500 = makePriceOnly(c.monthly.US_500, 2.2); },
    expect: (res) => res.priceOnlySeries.includes('US_500'),
    says: (res) => res.reconciliations.find((r) => r.seriesId === 'US_500').priceOnly.reason,
  },
  {
    name: 'price-only GLOBAL_EQUITY at 2.2pp/yr (no annual series to check against)',
    why: 'the composite check is the only ground truth this series has',
    apply: (c) => { c.monthly.GLOBAL_EQUITY = makePriceOnly(c.monthly.GLOBAL_EQUITY, 2.2); },
    expect: (res) => res.composites.find((x) => x.target === 'GLOBAL_EQUITY').status === 'FAIL',
    says: (res) => res.composites.find((x) => x.target === 'GLOBAL_EQUITY').findings.map((f) => f.message).join('; '),
  },
  {
    name: 'dropped month 2023-06 in US_500',
    why: 'a gap silently shortens a year and understates or overstates it',
    apply: (c) => { c.monthly.US_500 = dropMonth(c.monthly.US_500, '2023-06'); },
    expect: (res) => res.findings.some((f) => f.code === 'GAP'),
    says: (res) => res.findings.filter((f) => f.code === 'GAP').map((f) => f.message).join('; '),
  },
  {
    name: 'one month perturbed by +5.0pp (US_500 2024-03)',
    why: 'a transcription error in a single cell',
    apply: (c) => { c.monthly.US_500 = perturbMonth(c.monthly.US_500, '2024-03', 5); },
    expect: (res) => res.reconciliations.find((r) => r.seriesId === 'US_500')
      .rows.some((x) => x.year === 2024 && x.status === STATUS.FAIL),
    says: (res) => {
      const y = res.reconciliations.find((r) => r.seriesId === 'US_500').rows.find((x) => x.year === 2024);
      return `2024 compounds to ${y.compounded.toFixed(2)}% against a published ${y.annual}% (${y.diffBp.toFixed(0)}bp)`;
    },
  },
  {
    name: 'one month perturbed by +0.85pp (US_500 2024-03)',
    why: 'the smallest single-cell error that should still be visible above the noise floor',
    apply: (c) => { c.monthly.US_500 = perturbMonth(c.monthly.US_500, '2024-03', 0.85); },
    expect: (res) => res.reconciliations.find((r) => r.seriesId === 'US_500')
      .rows.some((x) => x.year === 2024 && x.status === STATUS.WARN),
    says: (res) => {
      const y = res.reconciliations.find((r) => r.seriesId === 'US_500').rows.find((x) => x.year === 2024);
      return `2024 residual ${y.diffBp.toFixed(0)}bp — WARN`;
    },
  },
  {
    name: 'decimal slip: US_500 2024-03 = 312.4%',
    why: 'a units or decimal-place error',
    apply: (c) => { c.monthly.US_500 = setMonth(c.monthly.US_500, '2024-03', 312.4); },
    expect: (res) => res.findings.some((f) => f.code === 'OUT_OF_RANGE'),
    says: (res) => res.findings.filter((f) => f.code === 'OUT_OF_RANGE').map((f) => f.message).join('; '),
  },
  {
    name: 'undocumented null in US_500',
    why: 'a hole nobody wrote down',
    apply: (c) => { c.monthly.US_500 = setMonth(c.monthly.US_500, '2024-03', null); },
    expect: (res) => res.findings.some((f) => f.code === 'NULL_VALUE' && f.severity === 'ERROR'),
    says: (res) => res.findings.filter((f) => f.code === 'NULL_VALUE' && f.severity === 'ERROR').map((f) => f.message).join('; '),
  },
  {
    name: 'keys out of order in US_500',
    why: 'an append that went in at the wrong place',
    apply: (c) => { c.monthly.US_500 = shuffleKeys(c.monthly.US_500, '2023-04', '2024-09'); },
    expect: (res) => res.findings.some((f) => f.code === 'NOT_CHRONOLOGICAL'),
    says: (res) => res.findings.filter((f) => f.code === 'NOT_CHRONOLOGICAL').map((f) => f.message).join('; '),
  },
  {
    name: 'GLOBAL_EQUITY replaced by a copy of US_TOTAL',
    why: 'the wrong column pasted from a spreadsheet',
    apply: (c) => { c.monthly.GLOBAL_EQUITY = { ...c.monthly.US_TOTAL }; },
    expect: (res) => res.composites.find((x) => x.target === 'GLOBAL_EQUITY')
      .findings.some((f) => f.code === 'IMPLIED_WEIGHT_OFF'),
    says: (res) => res.composites.find((x) => x.target === 'GLOBAL_EQUITY')
      .findings.map((f) => f.message).join('; '),
  },
  {
    name: 'GLOBAL_EQUITY monthly extended back to 2005 without declaring it constructed',
    why: 'exactly what the backward-extension pass is about to do',
    apply: (c) => {
      c.monthly.GLOBAL_EQUITY = { '2005-01': 1.2, '2005-02': -0.4, ...c.monthly.GLOBAL_EQUITY };
    },
    expect: (res) => res.findings.some((f) => f.code === 'PRE_INCEPTION_DATA'),
    says: (res) => res.findings.filter((f) => f.code === 'PRE_INCEPTION_DATA').map((f) => f.message).join('; '),
  },
  {
    name: 'CONTROL: +/-25bp of symmetric monthly noise on US_500',
    why: 'sourcing jitter must NOT be called price-only, or the alarm is worthless',
    apply: (c) => { c.monthly.US_500 = addNoise(c.monthly.US_500, 25, 7); },
    expect: (res) => !res.priceOnlySeries.includes('US_500'),
    says: (res) => res.reconciliations.find((r) => r.seriesId === 'US_500').priceOnly.reason,
  },
];

function printDemo(base) {
  const lines = [];
  lines.push(R.rule('DETECTION DEMO'));
  lines.push(R.dim('  Each row degrades the clean file one way and reports what the checker said.'));
  lines.push(R.dim(`  Baseline: ${base.label}`));
  const clean = runCheck(base);
  lines.push(`  clean file verdict: ${R.paintStatus(clean.verdict)}`);
  lines.push('');
  let failures = 0;
  for (const c of DEMO_CASES) {
    const degraded = clone(base);
    c.apply(degraded);
    const res = runCheck(degraded);
    const caught = c.expect(res);
    if (!caught) failures++;
    lines.push(`${caught ? R.green('CAUGHT') : R.red('MISSED')}  ${R.bold(c.name)}`);
    lines.push(R.dim(`        ${c.why}`));
    lines.push(`        ${R.dim('verdict')} ${R.paintStatus(res.verdict)}  ${R.dim('·')} ${c.says(res)}`);
    lines.push('');
  }
  lines.push(R.rule('VERDICT'));
  lines.push(failures
    ? '  ' + R.red(`${failures} of ${DEMO_CASES.length} faults went undetected — the harness is not trustworthy`)
    : '  ' + R.green(`all ${DEMO_CASES.length} cases behaved as expected`));
  console.log(lines.join('\n'));
  return failures ? 1 : 0;
}

// ------------------------------------------------------------------ main ----

function main(argv) {
  const { _, flags } = parseArgs(argv);
  if (flags.help || _.length === 0) { console.log(USAGE); return _.length === 0 ? 1 : 0; }
  if (flags['no-color'] || flags.json) R.setColor(false);

  const cmd = _[0];
  const series = flags.series ? String(flags.series).split(',').map((s) => s.trim()).filter(Boolean) : null;
  const as = flags.as;

  if (cmd === 'diff') {
    const [, fa, fb] = _;
    if (!fa || !fb) { console.error('diff needs two files'); return 2; }
    return printDiff(loadCandidate(fa, { force: as }), loadCandidate(fb, { force: as }), {
      series,
      json: flags.json,
      verbose: true,
      toleranceBp: num(flags['tolerance-bp'], 2),
      alarmBp: num(flags['alarm-bp'], 25),
      all: flags.all,
    });
  }

  const file = _[1] ?? DEFAULT_BENCHMARKS;
  const candidate = loadCandidate(file, { force: as });

  if (flags.annual) {
    const src = loadCandidate(flags.annual, { force: 'annual' });
    candidate.annual = src.annual;
    candidate.annualFrom = flags.annual;
    if (!candidate.meta) { candidate.meta = src.meta; candidate.borrowedMeta = true; }
  }

  if (cmd === 'noise-floor') return printNoiseFloor(candidate, { json: flags.json });
  if (cmd === 'demo') return printDemo(candidate);

  if (cmd === 'check') {
    const stratPath = flags.strategies ?? DEFAULT_STRATEGIES;
    const strategies = existsSync(resolve(stratPath)) ? readJson(resolve(stratPath)) : null;
    const res = runCheck(candidate, {
      series,
      strategies,
      warnBp: num(flags['warn-bp'], undefined),
      failBp: num(flags['fail-bp'], undefined),
    });
    if (flags.json) {
      console.log(JSON.stringify({
        verdict: res.verdict,
        priceOnlySeries: res.priceOnlySeries,
        findings: res.findings,
        reconciliations: res.reconciliations,
        composites: res.composites,
      }, null, 2));
      return res.verdict === STATUS.FAIL || (flags.strict && res.verdict === STATUS.WARN) ? 1 : 0;
    }
    return printCheck(res, { strict: flags.strict });
  }

  console.error(`unknown command "${cmd}"`);
  console.log(USAGE);
  return 2;
}

if (import.meta.url === `file://${process.argv[1]}`) {
  try {
    process.exit(main(process.argv.slice(2)));
  } catch (err) {
    console.error(`\n${err.message}\n`);
    process.exit(2);
  }
}
