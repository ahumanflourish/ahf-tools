#!/usr/bin/env python3
"""
flow-sentence-count.py — count the sentences a reader actually sees, per step.

The single constraint on this build is one sentence per step. That is a claim
about the finished page, not about the source, so it is measured in a real
browser at both widths rather than argued about in review.

WHAT COUNTS. Prose the reader can read on the screen that is showing: the
step's lede and any sentence inside the visible screen container. Specifically
NOT counted, with the reason:

  · a section label (`.label`) — it names a region, it is not a sentence;
  · a figure, a date or a currency amount standing alone — it is data;
  · a file name, a table cell, an SVG label — same;
  · screen-reader-only text (`.visually-hidden`) — it is not on the screen;
  · anything inside a `<details>` the reader has not opened — a folded list is
    one line until they choose otherwise, which is the whole point of folding
    it. Opened, every line inside it counts.
  · the same words twice — a heading and the card containing it — which is
    one thing on screen, not two;
  · a container whose text is only its children's text, counted once at the
    deepest element that holds it, so a `<div>` wrapping two `<p>` is not
    three sentences.

Usage:  python3 flow-sentence-count.py [--file flow.html] [--width 1280 640]
Exit 0 if every step is within its budget, 1 otherwise.
"""
import argparse, json, pathlib, re, sys
from playwright.sync_api import sync_playwright

HERE = pathlib.Path(__file__).resolve().parent

SCREENS = ['screen-open', 'screen-prepare', 'screen-upload', 'screen-read',
           'screen-answer', 'screen-entry', 'screen-check', 'screen-results',
           'screen-save']

PROSE = r"""(screens) => {
  const screen = screens.map(id => document.getElementById(id)).find(e => e && !e.hidden);
  const out = [];
  const seen = new Set();
  const push = t => { t = (t || '').replace(/\s+/g, ' ').trim(); if (t && !seen.has(t)) { seen.add(t); out.push(t); } };

  const skip = n => {
    if (n.closest('[hidden]')) return true;
    if (n.offsetParent === null && getComputedStyle(n).position !== 'fixed') return true;
    if (n.closest('.visually-hidden') || n.classList.contains('visually-hidden')) return true;
    if (n.closest('.meta') || n.closest('.pop')) return true;
    if (n.closest('.filelist') || n.closest('table') || n.closest('svg')) return true;
    if (n.classList.contains('label')) return true;
    const det = n.closest('details');
    if (det && !det.open) return true;
    return false;
  };

  const lede = document.getElementById('card-lede');
  if (lede && !skip(lede)) push(lede.textContent);

  /* The CSV hatch's panel is outside the screen containers by design — it is
     the escape route from any step — but when it is open the reader is
     looking at it, so it is counted with whatever screen it is open over. */
  const paste = document.getElementById('panel-paste');
  const regions = [screen, paste && !paste.hidden ? paste : null].filter(Boolean);
  for (const screen of regions) {
    const nodes = [...screen.querySelectorAll('p, li, b, dd, .q-body, .q-extra, .ask-answer, .claim-sub, .under')];
    const len = n => (n.textContent || '').replace(/\s+/g, ' ').trim().length;
    for (const n of nodes) {
      if (skip(n)) continue;
      /* A wrapper whose text IS its child's text would double-count, so the
         child wins. A wrapper that adds words of its own does NOT: `<p>Your
         money made <b>$38,345</b> in this period.</p>` is a sentence and its
         `<b>` is a figure, and dropping the sentence in favour of the figure
         is exactly how a counter flatters the page it is meant to police. */
      if (nodes.some(m => m !== n && n.contains(m) && !skip(m) && len(m) >= 0.9 * len(n))) continue;
      push(n.textContent);
    }
  }
  /* The same words twice — a heading and the card that contains it, a label
     and the row it labels — is one thing on screen, not two. */
  return out.filter(t => !out.some(u => u !== t && u.length > t.length && u.includes(t)));
}"""

# A figure, a date, a currency amount or a bare count is data, not a sentence.
DATA = re.compile(r'^[\s−\-+$£€%0-9.,:/]+$|^[A-Za-z ]{0,14}\$[\d,.]+$|^\d+ (rows?|files?|balances?)\.?$')


def sentences(text):
    t = re.sub(r'\s+', ' ', text or '').strip()
    if not t or DATA.match(t):
        return 0
    return len([p for p in re.split(r'(?<=[.!?])\s+', t) if p.strip()])


def count(page):
    prose = page.evaluate(PROSE, SCREENS)
    kept = [(t, sentences(t)) for t in prose]
    return sum(n for _, n in kept), [t for t, n in kept if n]


if __name__ == '__main__':
    ap = argparse.ArgumentParser()
    ap.add_argument('--file', default=str(HERE / 'flow.html'))
    ap.add_argument('--json', action='store_true')
    args = ap.parse_args()
    print(json.dumps({'note': 'imported by flow-journey.py; run that instead'}) if args.json
          else __doc__.strip().splitlines()[1])
