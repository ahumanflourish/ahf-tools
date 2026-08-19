#!/usr/bin/env node
/*
 * v1-scale-check.js — prove the y axis always has numbers on it.
 *
 * The defect this exists to catch: a log axis whose tick set comes back EMPTY.
 * It happened for two entirely ordinary shapes of data —
 *
 *   a portfolio that barely moved over the period   (50,000 .. 50,500)
 *   a flat or single-observation history            (min = max = 12,345)
 *
 * — because a window narrower than one step of the mantissa ladder contains no
 * round mantissa at all, and the ladder was the only thing that could produce
 * a tick. Every case below asserts the same contract, which is the contract
 * the chart actually needs: every tick finite, positive, strictly increasing,
 * inside the axis range, and at least two of them.
 *
 * The functions under test are LIFTED FROM v1.html, not copied into this file:
 * the source between the SCALE-LADDERS-BEGIN and SCALE-LADDERS-END markers is
 * read at run time and evaluated. There is therefore no second copy to drift,
 * and a check below fails loudly if either marker goes missing.
 *
 * Usage:  node v1-scale-check.js [--file v1.html]
 * Exit code 0 = pass, 1 = fail.
 */
'use strict';
const fs = require('fs');
const path = require('path');

const argFile = (() => {
  const i = process.argv.indexOf('--file');
  return i > 0 ? process.argv[i + 1] : path.join(__dirname, 'v1.html');
})();

/* ── lift the arithmetic out of the page ──────────────────────────────────── */
const BEGIN = 'SCALE-LADDERS-BEGIN';
const END = 'SCALE-LADDERS-END';
const html = fs.readFileSync(argFile, 'utf8');
const i = html.indexOf(BEGIN), j = html.indexOf(END);
if (i < 0 || j < 0 || j < i) {
  console.error('FATAL: could not find the ' + BEGIN + ' / ' + END + ' markers in ' +
    path.basename(argFile) + '. The block they fence is what this test drives; ' +
    'if it has been renamed or unfenced, this test is measuring nothing.');
  process.exit(1);
}
/* From the end of the opening marker comment to the start of the closing one. */
const block = html.slice(html.indexOf('*/', i) + 2, html.lastIndexOf('/*', j));
const scale = new Function(block +
  '\nreturn { niceDown, niceStep, logTicks, linearTicksIn, LOG_TIERS, FLOOR_STEPS };')();
const { niceDown, logTicks, LOG_TIERS, FLOOR_STEPS } = scale;

for (const name of ['niceDown', 'niceStep', 'logTicks', 'linearTicksIn']) {
  if (typeof scale[name] !== 'function') {
    console.error('FATAL: ' + name + ' is not defined inside the fenced block.');
    process.exit(1);
  }
}

/* ── the contract ─────────────────────────────────────────────────────────── */
function check(ticks, lo, hi) {
  const why = [];
  if (!Array.isArray(ticks)) return ['not an array'];
  if (ticks.length < 2) why.push('only ' + ticks.length + ' tick' + (ticks.length === 1 ? '' : 's'));
  ticks.forEach(function (v, k) {
    if (!isFinite(v)) why.push('tick ' + k + ' is not finite (' + v + ')');
    else if (!(v > 0)) why.push('tick ' + k + ' is not positive (' + v + ')');
    else if (v <= lo * (1 - 1e-9) || v > hi * (1 + 1e-9)) why.push('tick ' + k + ' = ' + v + ' is outside ' + lo + '..' + hi);
    if (k > 0 && !(v > ticks[k - 1])) why.push('tick ' + k + ' = ' + v + ' does not exceed ' + ticks[k - 1]);
  });
  return why;
}

/* The chart's own geometry, so the pixel budget the ladder is judged against
   is the real one rather than an invented one. plotH is H - top - bottom for
   the two widths the layout audit runs at; minGap is render()'s 40px, and the
   30px retry it falls back to when 40 leaves fewer than four labels. */
const HEIGHTS = { 1280: 480 - 28 - 46, 640: 340 - 28 - 46 };

/* Every case is stated as the DATA — a min and a max — and the floor and top
   are derived exactly as computeScale() derives them, so a case here is a
   portfolio somebody could actually have. */
const CASES = [
  ['tiny range, 1% apart',        50000,      50500],
  ['identical min and max',       12345,      12345],
  ['single cent',                 0.01,       0.01],
  ['pennies only',                0.03,       0.87],
  ['cents to millions',           0.02,       4200000],
  ['one decade',                  1000,       10000],
  ['just under one decade',       9000,       61000],
  ['half a decade',               8000,       24000],
  ['a fifth of a decade',         10000,      15800],
  ['the shipped fixture',         10014.74,   60979.28],
  ['the thirty-year fixture',     251.2,      780000],
  ['nine decades',                1,          1e9],
  ['1e9 .. 1e12',                 1e9,        1e12],
  ['two values 0.2% apart',       1000000,    1002000],
  ['a hair over one tick',        99000,      101000],
  ['crossing a decade at 1.01x',  9950,       10050]
];

let failures = 0, run = 0;
const rows = [];

function report(label, ticks, lo, hi, extra) {
  run++;
  const why = check(ticks, lo, hi);
  if (why.length) failures++;
  rows.push('  ' + (why.length ? 'FAIL' : 'ok  ') + '  ' + label.padEnd(46) + extra.padEnd(30) +
    (ticks.length ? ticks.map(fmt).join('  ') : '[]') +
    (why.length ? '\n          ' + why.join('; ') : ''));
}
function fmt(v) {
  if (v >= 1e9) return (v / 1e9) + 'bn';
  if (v >= 1e6) return (v / 1e6) + 'm';
  if (v >= 1000) return (v / 1000) + 'k';
  if (v < 1) return v.toPrecision(3).replace(/0+$/, '').replace(/\.$/, '');
  return String(Math.round(v * 100) / 100);
}

console.log('SCALE CHECK — ' + path.basename(argFile));
console.log('log tick ladders: ' + LOG_TIERS.map(t => t.join('/')).join('   then   '));
console.log('floor ladder:     ' + FLOOR_STEPS.join('/'));
console.log('');
console.log('1. LOG TICKS over every range, at both widths and both gap budgets');

CASES.forEach(function ([label, min, max]) {
  const floor = niceDown(min / 1.07);
  const top = max * 1.07;
  if (!(floor > 0) || !(top > floor)) { failures++; rows.push('  FAIL  ' + label + ' — computeScale gave floor ' + floor + ' top ' + top); return; }
  [1280, 640].forEach(function (w) {
    const plotH = HEIGHTS[w];
    const k = plotH / (Math.log(top) - Math.log(floor));
    [40, 30].forEach(function (gap) {
      report(label, logTicks(floor, top, k, gap), floor, top,
        w + 'px, gap ' + gap + ', floor ' + fmt(floor));
    });
  });
});
rows.forEach(r => console.log(r));

/* ── the floor ────────────────────────────────────────────────────────────── */
console.log('');
console.log('2. FLOOR — niceDown must land under the value and not far under it');
const FLOORS = [
  /* The floor is niceDown(min / 1.07), so a $10,000 minimum asks for
     niceDown(9,346) and gets $8,000 — close under the data. A 1/2/5 ladder
     would answer $5,000 here and spend a third of the plot on empty. */
  [10000 / 1.07, 8000], [9346, 8000], [10000, 10000], [50000, 50000], [12345, 10000],
  [0.01, 0.01], [780000, 600000], [1002000, 1000000], [61000, 60000]
];
FLOORS.forEach(function ([v, want]) {
  run++;
  const got = niceDown(v);
  const ok = Math.abs(got - want) < 1e-9;
  if (!ok) failures++;
  console.log('  ' + (ok ? 'ok  ' : 'FAIL') + '  niceDown(' + v + ') = ' + got +
    (ok ? '' : '  — expected ' + want) + '   (keeps ' +
    (100 * got / v).toFixed(0) + '% of the value)');
});

/* ── the degenerate call ──────────────────────────────────────────────────── */
console.log('');
console.log('3. DEGENERATE — a zero-width range, handled rather than fallen through');
run++;
const flat = logTicks(12345, 12345, 100, 40);
const flatOk = Array.isArray(flat) && flat.length === 1 && flat[0] === 12345;
if (!flatOk) failures++;
console.log('  ' + (flatOk ? 'ok  ' : 'FAIL') + '  logTicks(12345, 12345) = [' + flat +
  '] — one label, the only honest answer; computeScale() never asks this ' +
  'because it pads 7% either side.');
run++;
const bad = logTicks(0, 100, 100, 40);
const badOk = Array.isArray(bad) && bad.length === 0;
if (!badOk) failures++;
console.log('  ' + (badOk ? 'ok  ' : 'FAIL') + '  logTicks(0, 100) = [' + bad +
  '] — a floor of $0 has no logarithm; computeScale() refuses the whole view first.');

console.log('');
if (failures) {
  console.log('RESULT: FAIL — ' + failures + ' of ' + run + ' checks');
  process.exit(1);
}
console.log('RESULT: PASS — ' + run + ' checks; every range yields finite, positive,');
console.log('strictly increasing, in-range ticks, at least two of them');
process.exit(0);
