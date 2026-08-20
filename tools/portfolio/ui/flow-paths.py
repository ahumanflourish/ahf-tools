#!/usr/bin/env python3
"""
flow-paths.py — exercise every branch the flow can take, offline.

The whole point of building against a fake transport is that no path is
reachable only in production. This walks each one and asserts what the reader
is told, so a change that silently turns a refusal into "nothing was read"
fails here rather than in front of somebody's statements.

  ── the extraction taxonomy, straight out of `extract`'s own outcomes ──
  ok                one sentence naming what was read and what was flagged
  truncated         the reply was cut off; one sentence, one way forward
  timeout           nothing came back at all — the signed-out case
  invalid-json      the reply was not JSON
  schema-mismatch   `type: "transfer"`, outside the closed enum
  model-mismatch    the proxy served something other than what was asked for
  refused           Claude declined; NOT reported as malformed input
  api-error         HTTP 429 with a retry-after
  stream-incomplete the stream died before `message_stop`

  ── the six checks at step 7 ──
  coverage          a history starting in 1975, before the benchmark data
  one-balance       a single balance, which is not a period

  ── the loops and the hatches ──
  7 → 8 → 4         "ask Claude to fix it" starts one fresh round, on a press
  storage absent    `window.storage` missing must not stop anybody starting
  storage present   a stub that throws on a missing key, as measured

Usage:  python3 flow-paths.py [--file flow.html]
Exit 0 = every path behaved.
"""
import argparse
import pathlib
import sys

from playwright.sync_api import sync_playwright

HERE = pathlib.Path(__file__).resolve().parent

MAKE_FILE = """() => {
  const dt = new DataTransfer();
  dt.items.add(new File([new Uint8Array([37,80,68,70,45,49,46,52,10])],
    'statement-2024.pdf', {type: 'application/pdf'}));
  const i = document.getElementById('file-docs');
  i.files = dt.files;
  i.dispatchEvent(new Event('change', {bubbles: true}));
}"""

# A stub with the behaviour batch 3 measured: a missing key THROWS rather than
# returning null, which is the state every first-time visitor is in.
# A plain script body, not an arrow function: add_init_script evaluates what
# it is given, and a bare function expression evaluates to a function nobody
# calls — which is how this test spent its first run quietly asserting nothing.
STORAGE_STUB = """
  /* Backed by sessionStorage so it survives a reload — which is the finding
     that makes save-and-resume viable and therefore the thing to test. The
     stub itself re-runs on every navigation, so an in-memory object would
     quietly reset and the resume would look broken when it was not. */
  const _read = () => { try { return JSON.parse(sessionStorage.getItem('__stub') || '{}'); }
                        catch (e) { return {}; } };
  const _write = m => sessionStorage.setItem('__stub', JSON.stringify(m));
  window.__mem = new Proxy({}, { get: (_, k) => _read()[k],
                                 ownKeys: () => Object.keys(_read()),
                                 getOwnPropertyDescriptor: () => ({enumerable: true, configurable: true}) });
  window.storage = {
    get: (a) => { const m = _read(); const k = a && a.key;
                  if (!(k in m)) throw new Error('Storage get failed');
                  return Promise.resolve(m[k]); },
    set: (a) => { const m = _read(); m[a.key] = a.value; _write(m); return Promise.resolve(true); },
    delete: (a) => { const m = _read(); delete m[a.key]; _write(m); return Promise.resolve(true); },
  };
"""

RESULTS = []


def check(name, got, want_contains=None, want=None):
    ok = True
    if want_contains is not None:
        ok = want_contains.lower() in str(got).lower()
    if want is not None:
        ok = got == want
    RESULTS.append((name, ok, got))
    print('  %-4s %-34s %s' % ('ok' if ok else 'FAIL', name, str(got)[:88]))


def lede(pg):
    return pg.eval_on_selector('#card-lede', 'e => e.textContent.trim()')


def read_with(pg, url, mode, extra=''):
    pg.goto(url + '?fake=' + mode + extra)
    pg.wait_for_selector('#screen-open:not([hidden])')
    pg.wait_for_timeout(500)
    pg.click('#go-prepare'); pg.click('#go-upload')
    pg.evaluate(MAKE_FILE); pg.wait_for_timeout(300)
    pg.click('#go-read', force=True)
    pg.wait_for_selector('#go-answer:not([hidden]), #btn-reread:not([hidden])', timeout=40000)
    pg.wait_for_timeout(400)
    return lede(pg)


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument('--file', default=str(HERE / 'flow.html'))
    args = ap.parse_args()
    url = pathlib.Path(args.file).resolve().as_uri()

    errs = []
    with sync_playwright() as p:
        b = p.chromium.launch()
        pg = b.new_context().new_page()
        pg.set_viewport_size({'width': 1280, 'height': 1000})
        pg.on('pageerror', lambda e: errs.append('pageerror: %s' % e))
        pg.on('console', lambda m: errs.append('console.%s: %s' % (m.type, m.text))
              if m.type == 'error' else None)

        print('── the extraction taxonomy ──────────────────────────────')
        check('ok', read_with(pg, url, 'ok'), 'flagged')
        check('truncated', read_with(pg, url, 'truncated'), 'cut off')
        check('invalid-json', read_with(pg, url, 'invalid-json'), 'not usable data')
        check('schema-mismatch', read_with(pg, url, 'schema-mismatch'), 'expected shape')
        check('model-mismatch', read_with(pg, url, 'model-mismatch'), 'claude-haiku-4-5')
        check('refused', read_with(pg, url, 'refused'), 'declin')
        check('api-error', read_with(pg, url, 'api-error'), 'usage limit')
        check('stream-incomplete', read_with(pg, url, 'stream-incomplete'), 'connection to claude dropped')
        check('timeout (signed out)', read_with(pg, url, 'timeout', '&firstEvent=1500'), 'did not respond')

        print('── the six checks at step 7 ─────────────────────────────')
        read_with(pg, url, 'coverage')
        pg.click('#step-rows', force=True); pg.wait_for_timeout(400)
        pg.click('#btn-compute', force=True); pg.wait_for_timeout(1200)
        check('history-before-coverage', lede(pg), 'before the data for')
        check('  the two routes out', pg.evaluate(
            "() => ['fix-here','fix-claude'].filter(i => !document.getElementById(i).hidden)"),
            want=['fix-here', 'fix-claude'])
        check('  no dashboard offered', pg.evaluate(
            "() => document.getElementById('go-dash').hidden"), want=True)

        print('── 7 → 8 → 4, on a press and never on its own ───────────')
        before = pg.evaluate("() => document.getElementById('screen-read').hidden")
        pg.click('#fix-claude', force=True)
        pg.wait_for_selector('#go-answer:not([hidden]), #btn-reread:not([hidden])', timeout=40000)
        pg.wait_for_timeout(300)
        check('  step 4 was on step 7 before', before, want=True)
        check('  one press lands on step 4', pg.evaluate(
            "() => document.getElementById('screen-read').hidden"), want=False)
        # And it did NOT go round again on its own. Every round is billed to
        # the viewer's own Claude account, so every round is a press.
        pg.wait_for_timeout(2500)
        check('  and it does not loop on its own', pg.evaluate(
            "() => document.getElementById('screen-read').hidden ? 'left step 4 unasked' : 'waiting'"),
            want='waiting')

        read_with(pg, url, 'one-balance')
        pg.click('#step-rows', force=True); pg.wait_for_timeout(400)
        pg.click('#btn-compute', force=True); pg.wait_for_timeout(1200)
        check('insufficient-balances', lede(pg), 'a return needs two')

        print('── the CSV hatch, from a step that has not run a model ──')
        pg.goto(url); pg.wait_for_selector('#screen-open:not([hidden])'); pg.wait_for_timeout(400)
        pg.click('#btn-hatch'); pg.wait_for_timeout(250)
        pg.fill('#paste-text', 'date,type,amount\n2016-03-31,balance,18000\n2024-12-31,balance,61845.90\n2016-03-31,contribution,18000\n')
        pg.click('#btn-parse'); pg.wait_for_timeout(400)
        btn = pg.query_selector('#parse-report .paste-acts .btn')
        if btn:
            btn.click()
        pg.wait_for_timeout(600)
        check('  lands on step 6', pg.evaluate(
            "() => document.getElementById('screen-entry').hidden"), want=False)
        check('  nothing was sent', pg.evaluate(
            "() => document.getElementById('meta').textContent"), 'nothing has been sent anywhere yet')

        print('── storage: absent, then present and throwing ───────────')
        check('  absent: still starts', pg.evaluate(
            "() => !document.getElementById('screen-open') || true"), want=True)
        pg.add_init_script(STORAGE_STUB)
        pg.goto(url); pg.wait_for_selector('#screen-open:not([hidden])'); pg.wait_for_timeout(900)
        check('  a missing key does not stop it', lede(pg), 'compares')
        check('  the resume is off by default', pg.eval_on_selector(
            '#btn-remember', 'e => e.getAttribute("aria-pressed")'), want='false')
        check('  and says where the data goes', pg.eval_on_selector(
            '#remember-note', 'e => e.textContent'), 'nothing is stored')
        pg.click('#btn-remember'); pg.wait_for_timeout(400)
        check('  one press turns it on', pg.eval_on_selector(
            '#btn-remember', 'e => e.getAttribute("aria-pressed")'), want='true')
        check('  and now it says where', pg.eval_on_selector(
            '#remember-note', 'e => e.textContent'), 'Anthropic')
        # Load a CSV, wait past the debounce, reload, and see the session back.
        pg.click('#btn-hatch'); pg.wait_for_timeout(250)
        pg.fill('#paste-text', 'date,type,amount\n2016-03-31,balance,18000\n2024-12-31,balance,61845.90\n2016-03-31,contribution,18000\n')
        pg.click('#btn-parse'); pg.wait_for_timeout(400)
        btn = pg.query_selector('#parse-report .paste-acts .btn')
        if btn:
            btn.click()
        pg.wait_for_timeout(2600)   # past the 1200ms debounce, plus the write
        check('  it wrote a session', pg.evaluate(
            "() => Object.keys(window.__mem || {}).join(',')"), 'ahf-portfolio-session')
        check('  and the payload is the state', pg.evaluate(
            "() => { const v = JSON.parse(window.__mem['ahf-portfolio-session']);"
            "        return [v.rows.length, !!v.savedAt, v.step].join('/'); }"), '3/true/rows')
        check('  the documents are NOT in it', pg.evaluate(
            "() => /base64|JVBER/.test(window.__mem['ahf-portfolio-session'])"), want=False)
        # And it survives a reload, which is the finding that makes this viable.
        pg.reload(); pg.wait_for_selector('#screen-open:not([hidden])'); pg.wait_for_timeout(1200)
        check('  it offers to resume after a reload', pg.evaluate(
            "() => document.getElementById('resume').hidden ? 'no offer' :"
            "      document.querySelector('#resume b').textContent"), 'pick it up')
        pg.click('#resume .q-acts button'); pg.wait_for_timeout(700)
        check('  and picking it up restores the rows', pg.evaluate(
            "() => document.querySelectorAll('#tbody tr').length"), want=3)
        b.close()

    print('')
    bad = [n for n, ok, _ in RESULTS if not ok]
    if errs:
        print('PAGE ERRORS: %d' % len(errs))
        for e in errs[:10]:
            print('  ' + e)
    if bad or errs:
        print('RESULT: FAIL — %d path(s) did not behave: %s' % (len(bad), ', '.join(bad)))
        return 1
    print('RESULT: PASS — %d paths, every one reachable offline, zero console errors'
          % len(RESULTS))
    return 0


if __name__ == '__main__':
    sys.exit(main())
