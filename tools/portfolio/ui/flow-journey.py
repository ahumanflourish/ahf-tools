#!/usr/bin/env python3
"""
flow-journey.py — walk the whole guided flow, shoot every step, count the
sentences on each screen, and fail on a single console error.

Three journeys, at every width:

  1. THE FLOW ITSELF. Open → prepare → upload → Claude reads → answer →
     the rows → the check → the dashboard → save. The upload is a real File
     built in the page, because a headless run has no file picker; everything
     after it is the real path — the real extract module, the real SSE
     decoder, the real engine, the real chart.
  2. THE CSV SKIP. The hatch that is on every screen, taken from step 1, which
     is the case where the model is never called at all.
  3. A VALIDATION FAILURE. `?fake=coverage` returns a history that starts in
     1975, before the benchmark data, so step 7 refuses and step 8 offers the
     two ways out.

The sentence count is the point. See flow-sentence-count.py for what counts
and what does not; the budget below is per step and is deliberately tight.

Usage:  python3 flow-journey.py [--file flow.html] [--width 1280 640]
Exit 0 = every step within budget and no console errors.
"""
import argparse, pathlib, sys

from playwright.sync_api import sync_playwright

# The counter lives in its own file so the rule it enforces can be read
# without reading the driver. The filename is hyphenated like every other
# script here, so it is loaded rather than imported.
import importlib.util as _ilu
_spec = _ilu.spec_from_file_location(
    'flow_sentence_count', pathlib.Path(__file__).resolve().parent / 'flow-sentence-count.py')
_mod = _ilu.module_from_spec(_spec)
_spec.loader.exec_module(_mod)
count = _mod.count

HERE = pathlib.Path(__file__).resolve().parent
SHOTS = HERE / 'shots-flow'

# What each screen may spend. The dashboard is the one place a larger number
# is correct: every sentence on it is a figure the engine produced or a
# finding it raised, which is what the reader came for, not explanation of it.
BUDGET = {
    '01-open': 4, '02-prepare': 2, '02b-ask-box': 2, '03-upload': 2,
    '03b-upload-ready': 2, '04-read-flags': 2, '04b-flags-open': 16,   # one line per flag, opened on purpose
    '05-answer': 3, '06-rows': 4, '07-check': 2, '08-fix': 2,
    '09-dashboard-value': 6, '09b-dashboard-kept': 12, '10-save': 2,
    'csv-hatch': 6, 'csv-loaded': 4,   # step 1 behind it, plus the panel's own line 'validation-failure': 2,
}

MAKE_FILE = """() => {
  const dt = new DataTransfer();
  dt.items.add(new File([new Uint8Array([37,80,68,70,45,49,46,52,10])],
    'statement-2024.pdf', {type: 'application/pdf'}));
  const input = document.getElementById('file-docs');
  input.files = dt.files;
  input.dispatchEvent(new Event('change', {bubbles: true}));
}"""

CSV = """date,type,amount
2016-03-31,contribution,18000
2016-03-31,balance,18000
2018-12-31,balance,26940.12
2020-12-31,balance,39980
2022-12-30,balance,41260.40
2024-12-31,balance,61845.90
"""


class Run:
    def __init__(self, page, url, width):
        self.page, self.url, self.width = page, url, width
        self.rows = []

    def shot(self, name):
        self.page.wait_for_timeout(180)
        SHOTS.mkdir(exist_ok=True)
        self.page.screenshot(path=str(SHOTS / ('%s-%d.png' % (name, self.width))), full_page=True)
        n, prose = count(self.page)
        cap = BUDGET.get(name, 2)
        self.rows.append((name, n, cap, prose))
        print('  %-22s %2d / %2d %s' % (name, n, cap, 'OVER' if n > cap else ''))

    def open(self, query=''):
        self.page.set_viewport_size({'width': self.width, 'height': 1000})
        self.page.goto(self.url + query)
        self.page.wait_for_timeout(900)

    # ── journey 1 ────────────────────────────────────────────────────
    def flow(self):
        pg = self.page
        self.open()
        self.shot('01-open')
        pg.click('#go-prepare'); pg.wait_for_timeout(220)
        self.shot('02-prepare')
        pg.fill('#target-year-2', '2050'); pg.dispatch_event('#target-year-2', 'change')
        pg.click('#btn-ask'); pg.wait_for_timeout(220)
        self.shot('02b-ask-box')
        pg.click('#btn-ask'); pg.wait_for_timeout(140)
        pg.click('#go-upload'); pg.wait_for_timeout(220)
        self.shot('03-upload')
        pg.evaluate(MAKE_FILE); pg.wait_for_timeout(350)
        self.shot('03b-upload-ready')
        pg.click('#go-read')
        pg.wait_for_selector('#go-answer:not([hidden])', timeout=30000)
        pg.wait_for_timeout(350)
        self.shot('04-read-flags')
        pg.click('#panel-flags summary'); pg.wait_for_timeout(200)
        self.shot('04b-flags-open')
        pg.click('#panel-flags summary'); pg.wait_for_timeout(140)
        pg.click('#go-answer'); pg.wait_for_timeout(350)
        self.shot('05-answer')
        for _ in range(50):
            if pg.evaluate("() => document.getElementById('screen-answer').hidden"):
                break
            btns = pg.query_selector_all('#panel-question .q-acts button')
            if not btns:
                break
            btns[0].click()
            pg.wait_for_timeout(120)
        pg.wait_for_timeout(300)
        if pg.evaluate("() => document.getElementById('screen-entry').hidden"):
            pg.click('#step-rows', force=True)
        pg.wait_for_timeout(450)
        self.shot('06-rows')
        pg.click('#btn-compute', force=True); pg.wait_for_timeout(1500)
        self.shot('07-check')
        pg.click('#go-dash'); pg.wait_for_timeout(1100)
        self.shot('09-dashboard-value')
        pg.click('#view-kept'); pg.wait_for_timeout(800)
        self.shot('09b-dashboard-kept')
        pg.click('#step-save', force=True); pg.wait_for_timeout(400)
        self.shot('10-save')

    # ── journey 2 ────────────────────────────────────────────────────
    def csv(self):
        pg = self.page
        self.open()
        pg.click('#btn-hatch'); pg.wait_for_timeout(320)
        self.shot('csv-hatch')
        pg.fill('#paste-text', CSV)
        pg.click('#btn-parse'); pg.wait_for_timeout(450)
        btn = pg.query_selector('#parse-report .paste-acts .btn')
        if btn:
            btn.click()
        pg.wait_for_timeout(700)
        self.shot('csv-loaded')

    # ── journey 3 ────────────────────────────────────────────────────
    def failure(self):
        pg = self.page
        self.open('?fake=coverage')
        pg.click('#go-prepare'); pg.click('#go-upload')
        pg.evaluate(MAKE_FILE); pg.wait_for_timeout(350)
        pg.click('#go-read')
        pg.wait_for_selector('#go-answer:not([hidden]), #btn-reread:not([hidden])', timeout=30000)
        pg.wait_for_timeout(300)
        pg.click('#step-rows', force=True); pg.wait_for_timeout(450)
        pg.click('#btn-compute', force=True); pg.wait_for_timeout(1400)
        self.shot('validation-failure')
        print('    refused with:', pg.eval_on_selector('#card-lede', 'e => e.textContent'))
        print('    routes out  :', pg.evaluate(
            "() => ['fix-here','fix-claude','go-dash'].filter(i => !document.getElementById(i).hidden)"))


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument('--file', default=str(HERE / 'flow.html'))
    ap.add_argument('--width', nargs='*', type=int, default=[1280, 640])
    args = ap.parse_args()
    url = pathlib.Path(args.file).resolve().as_uri()

    errs, rows = [], []
    with sync_playwright() as p:
        b = p.chromium.launch()
        pg = b.new_context(device_scale_factor=1).new_page()
        pg.on('pageerror', lambda e: errs.append('pageerror: %s' % e))
        pg.on('console', lambda m: errs.append('console.%s: %s' % (m.type, m.text))
              if m.type == 'error' else None)
        for w in args.width:
            print('── %dpx ─────────────────────────────────────────' % w)
            r = Run(pg, url, w)
            r.flow(); r.csv(); r.failure()
            rows += [(w,) + t for t in r.rows]
        b.close()

    print('\nSENTENCES ON SCREEN, PER STEP')
    over = []
    for w, name, n, cap, prose in rows:
        flag = 'OVER' if n > cap else ''
        if flag:
            over.append((w, name, n, cap))
        print('  %4d  %-22s %2d (budget %2d) %s' % (w, name, n, cap, flag))
        for t in prose:
            print('          · %s' % (t[:104] + ('…' if len(t) > 104 else '')))

    print('\nconsole/page errors: %d' % len(errs))
    for e in errs[:20]:
        print('  ' + e)
    if over:
        print('RESULT: FAIL — %d screen(s) over budget' % len(over))
        return 1
    if errs:
        print('RESULT: FAIL — console errors')
        return 1
    print('RESULT: PASS — every screen within budget, zero console errors')
    return 0


if __name__ == '__main__':
    sys.exit(main())
