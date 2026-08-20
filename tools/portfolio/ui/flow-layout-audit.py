#!/usr/bin/env python3
"""
flow-layout-audit.py — prove that the controls the reader aims at do not move,
across the whole ten-step flow.

Adapted from reference/app-layout-audit.py, which was adapted from
table-layout-audit.py, which was adapted from v1-layout-audit.py. Same defect
every time: something appears, everything below it reflows, the controls move,
and someone who clicks twice in the same place hits two different things.

This build is a harder case than the reference one, not an easier one. There
were three screens there and there are nine here, the reader crosses between
them on nearly every action, and three blocks are shared by all of them — the
masthead, the step strip and the card head. A crossing that used to be rare is
now the single most common transition in the tool.

═══ THE RULE, IN TWO PARTS ═══════════════════════════════════════════════

ZONE A — everything the reader comes back to, wherever they are:

    ALWAYS: the masthead, the page title, the ten step buttons, the card head
    (measured WITH ITS HEIGHT, because reserving that height is the whole
    point — moving between steps must swap text inside a box whose size was
    already decided), and the escape hatch, which is four controls in a fixed
    place on every screen for the whole hour.

    PER SCREEN: the one action row a step ends with, the upload target, the
    review table's toolbar, summary, strategy picker, fee and target-year
    fields and gate button, and on the dashboard the view switch, the chart
    actions, the rails, the plot areas and V2's two reserved blocks.

    ZONE A NEVER MOVES. Not for any transition, not by a pixel.

ZONE B — what answers back: the table and its panels, the flag list, the
question card, the check result, the cautions, the notes, the footer meta.
Growth is allowed here and confined here, under the FLOOR RULE:

    a transition declares a FLOOR — the element at the point of change. Any
    box whose top edge was ABOVE that floor before the transition must not
    move. Boxes at or below it may.

A step with no floor is checked STRICTLY: nothing on the page may move at all.
Every step change is in that category apart from the ones that open a panel,
because a step change swaps one screen for another BELOW a shared header that
must be still — which is exactly what `floor='screen'` measures.

Boxes are measured in DOCUMENT coordinates (viewport rect + scroll offset) so
that a panel scrolling itself into view does not register as everything else
moving. A box with no rendered area is not recorded: the hidden screens are
not "at the origin", they are not on the page, and a box that was not there
before cannot have moved.

Usage:  python3 flow-layout-audit.py [--file flow.html] [--width 1280 640]
Exit code 0 = pass, 1 = fail.
"""
import argparse
import pathlib
import sys

from playwright.sync_api import sync_playwright

HERE = pathlib.Path(__file__).resolve().parent
TOL = 0.5  # px. Sub-pixel text metrics move by less than this; a reflow does not.

PROBE = r"""
() => {
  const sx = window.scrollX, sy = window.scrollY;
  const rendered = el => { const r = el.getBoundingClientRect(); return r.width > 0 || r.height > 0; };
  const box = el => { const r = el.getBoundingClientRect(); return [r.left + sx, r.top + sy, r.width, r.height]; };
  const out = {};
  const put = (name, el) => { if (el && rendered(el)) out[name] = box(el); };

  /* ── ZONE A: shared by every one of the ten steps ─────────────────── */
  put('A:masthead', document.querySelector('.masthead'));
  put('A:h1', document.querySelector('.head h1'));
  put('A:steps', document.getElementById('steps'));
  document.querySelectorAll('#steps button').forEach(b => put('A:step ' + b.id, b));
  /* Measured WITH its height. That is the point of reserving it. */
  put('A:card-head', document.getElementById('card-head'));
  /* The hatch is on screen for the whole hour and must never move or resize. */
  put('A:hatch', document.getElementById('hatch'));
  ['btn-hatch', 'btn-save', 'btn-load', 'btn-remember'].forEach(id => put('A:hatch ' + id, document.getElementById(id)));

  /* ── ZONE A: the action row each step ends with ───────────────────── */
  ['act-open', 'act-prepare', 'act-upload', 'act-read', 'act-answer', 'act-check', 'act-save']
    .forEach(id => put('A:act ' + id, document.getElementById(id)));
  ['go-prepare', 'go-upload', 'go-read', 'go-answer', 'btn-reread', 'btn-ask',
   'btn-q-back', 'btn-q-skip', 'go-dash', 'fix-here', 'fix-claude',
   'save-json', 'save-csv', 'save-back', 'btn-pick', 'target-year-2']
    .forEach(id => put('A:ctl ' + id, document.getElementById(id)));
  put('A:drop', document.getElementById('drop'));

  /* ── ZONE A: the review table's own controls ──────────────────────── */
  put('A:toolbar', document.getElementById('toolbar'));
  put('A:summary', document.getElementById('summary'));
  put('A:gate-refs', document.getElementById('gate-refs'));
  document.querySelectorAll('#toolbar button, #gate-refs button').forEach(b => {
    put('A:btn ' + (b.id || (b.textContent || '').trim().slice(0, 22)), b);
  });
  put('A:btn #btn-compute', document.getElementById('btn-compute'));
  put('A:field #fee', document.getElementById('fee'));
  put('A:field #target-year', document.getElementById('target-year'));
  document.querySelectorAll('#summary .slot').forEach((s, i) => put('A:slot ' + i, s));

  /* ── ZONE A: the dashboard ────────────────────────────────────────── */
  put('A:results-head', document.getElementById('results-head'));
  document.querySelectorAll('#results-head .choice').forEach(b => put('A:btn ' + b.id, b));
  ['v1-refs', 'v1-context', 'v2-refs'].forEach(id => {
    const host = document.getElementById(id);
    if (!host) return;
    put('A:rail ' + id, host);
    host.querySelectorAll('input').forEach(i => {
      put('A:input ' + i.id, i);
      put('A:label ' + i.id, i.closest('.ref-label'));
    });
    /* Namespaced by the rail: both rails offer the same strategies, so an
       un-namespaced name would compare V1's button against V2's. */
    host.querySelectorAll('.pop-btn').forEach(b =>
      put('A:pop ' + id + ' "' + b.getAttribute('aria-label') + '"', b));
  });
  const chart = document.querySelector('svg.chart');
  if (chart) {
    put('A:v1 svg', chart);
    put('A:v1 plot area', chart.querySelector('rect[style*="crosshair"]'));
  }
  put('A:v2 svg', document.querySelector('svg.bar'));
  put('A:reserved #v2-claim', document.getElementById('v2-claim'));
  put('A:reserved #v2-under', document.getElementById('v2-under'));

  /* ── ZONE B: what answers back ────────────────────────────────────── */
  put('B:progress', document.getElementById('read-progress'));
  ['panel-flags', 'panel-question', 'panel-check', 'panel-ask', 'panel-paste',
   'panel-transfers', 'panel-problems', 'panel-dq', 'panel-extract', 'panel-result']
    .forEach(id => { const e = document.getElementById(id); if (e && !e.hidden) put('B:' + id, e); });
  put('B:filelist', document.getElementById('filelist'));
  put('B:resume', document.getElementById('resume'));
  put('B:table', document.getElementById('tbl'));
  put('B:thead', document.querySelector('#tbl thead tr'));
  /* Row controls are named by WHAT they are, never by index: a popover opening
     inside a row inserts a button, and an index-named box would re-map. */
  document.querySelectorAll('#tbody tr').forEach(tr => {
    const rid = tr.dataset.rid;
    put('B:row ' + rid, tr);
    put('B:row ' + rid + ' date', tr.querySelector('[data-field="date"]'));
    put('B:row ' + rid + ' amount', tr.querySelector('[data-field="amount"]'));
    tr.querySelectorAll('.seg button').forEach(b => put('B:row ' + rid + ' type ' + b.dataset.type, b));
    put('B:row ' + rid + ' del', tr.querySelector('.del-btn'));
  });
  put('B:addrow', document.getElementById('btn-addrow'));
  put('B:legend', document.getElementById('legend'));
  ['v1-cautions', 'v1-scale-note', 'v2-cautions', 'v2-note'].forEach(id => put('B:' + id, document.getElementById(id)));
  const rdq = document.getElementById('rdq-panel');
  if (rdq && !rdq.hidden) put('B:rdq-panel', rdq);
  const rt = document.getElementById('results-table');
  if (rt && !rt.hidden) put('B:results-table', rt);
  put('B:findings', document.getElementById('results-findings'));
  put('B:meta', document.getElementById('meta'));

  return { boxes: out, pageHeight: document.documentElement.scrollHeight };
}
"""

FLOORS = {
    'flags':     '#panel-flags',
    'question':  '#panel-question',
    'check':     '#panel-check',
    'ask':       '#panel-ask',
    'paste':     '#panel-paste',
    'files':     '#filelist',
    'progress':  '#read-progress',
    'table':     '#tbl',
    'rows':      '#tbody',
    'problems':  '#panel-problems',
    'dq':        '#panel-dq',
    'legend':    '#legend',
    'v1caut':    '#v1-cautions',
    'v1note':    '#v1-scale-note',
    'v2caut':    '#v2-cautions',
    'rdq':       '#rdq-panel',
    'rtable':    '#results-table',
    'meta':      '#meta',
}

# The floor for a change of step: the top of whichever screen container shows.
# Above it live the masthead, the title, the step strip, the card head and the
# hatch, and none of them may move for any reason.
SCREEN_FLOOR = """() => {
  const ids = ['screen-open','screen-prepare','screen-upload','screen-read','screen-answer',
               'screen-entry','screen-check','screen-results','screen-save'];
  const e = ids.map(i => document.getElementById(i)).find(x => x && x.getBoundingClientRect().height > 0);
  return e ? e.getBoundingClientRect().top + window.scrollY : Infinity;
}"""


def CONTAINER(key):
    """Zone-B boxes that are containers of other measured boxes: their height
    IS their content, and everything inside them is measured separately."""
    if key.startswith('B:panel-') or key in (
            'B:table', 'B:legend', 'B:rdq-panel', 'B:results-table', 'B:meta',
            'B:v1-cautions', 'B:v1-scale-note', 'B:v2-cautions', 'B:v2-note',
            'B:findings', 'B:filelist', 'B:resume', 'B:progress'):
        return True
    parts = key.split(' ')
    return len(parts) == 2 and parts[0] == 'B:row'


class Audit:
    def __init__(self, page, label):
        self.page = page
        self.label = label
        self.prev = None
        self.marks = {}
        self.failures = []
        self.lines = []

    def measure(self):
        return self.page.evaluate(PROBE)

    def mark(self, name):
        self.marks[name] = self.prev
        self.lines.append('  mark      %-54s  remembered' % name)

    def floor_y(self, spec):
        if spec is None:
            return float('inf')
        if spec == 'screen':
            return self.page.evaluate(SCREEN_FLOOR)
        if isinstance(spec, (int, float)):
            return float(spec)
        sel = FLOORS.get(spec, spec)
        # A HIDDEN panel has a 0x0 rect, and a floor of 0 would wave the whole
        # page through. The floor for a panel about to open is where it WILL
        # open: the bottom of the last laid-out thing before it. An EMPTY one
        # is different — a grid area with nothing in it still has a position,
        # and that position IS the point of change — so "laid out" here is
        # width OR height, not height alone.
        return self.page.evaluate(
            """(sel) => {
                 const e = document.querySelector(sel);
                 if (!e) return Infinity;
                 const vis = x => { if (!x) return false;
                   const r = x.getBoundingClientRect(); return r.width > 0 || r.height > 0; };
                 if (vis(e)) return e.getBoundingClientRect().top + window.scrollY;
                 let p = e.previousElementSibling;
                 while (p && !vis(p)) p = p.previousElementSibling;
                 if (p) return p.getBoundingClientRect().bottom + window.scrollY;
                 return e.parentElement.getBoundingClientRect().top + window.scrollY;
               }""", sel)

    def step(self, name, action=None, floor=None, note='', against=None, settle=140):
        floor_before = self.floor_y(floor) if floor is not None else float('inf')
        if action:
            action()
            self.page.wait_for_timeout(settle)
        cur = self.measure()
        base = self.marks[against] if against else self.prev
        if base is None:
            self.lines.append('  baseline  %-54s  %d boxes, page %dpx'
                              % (name, len(cur['boxes']), cur['pageHeight']))
            self.prev = cur
            return

        moved, allowed = [], []
        for key, b in cur['boxes'].items():
            a = base['boxes'].get(key)
            if a is None:
                continue
            d = [round(b[i] - a[i], 2) for i in range(4)]
            # Position and width always; HEIGHT too for zone A — a zone-A block
            # that grows is exactly the defect this file exists to catch, and
            # the card head, the hatch and V2's two reserved blocks are checked
            # on it — but not for a zone-B container, whose height is content.
            watch = d if (key.startswith('A:') or not CONTAINER(key)) else d[:3]
            if not any(abs(v) > TOL for v in watch):
                continue
            if key.startswith('A:') or a[1] < floor_before - TOL:
                moved.append((key, d))
            else:
                allowed.append((key, d))

        dh = cur['pageHeight'] - base['pageHeight']
        if floor is None:
            floor_txt = 'strict'
        elif floor == 'screen':
            floor_txt = 'floor screen top @%.0f' % floor_before
        else:
            floor_txt = 'floor %s @%.0f' % (floor, floor_before)
        if against:
            floor_txt += ', vs mark "%s"' % against
        if moved:
            self.lines.append('  FAIL      %-54s  %s, page %dpx (%+d)'
                              % (name, floor_txt, cur['pageHeight'], dh))
            for key, d in moved[:14]:
                self.lines.append('            %-46s dx %+.1f  dy %+.1f  dw %+.1f  dh %+.1f'
                                  % (key, d[0], d[1], d[2], d[3]))
            if len(moved) > 14:
                self.lines.append('            … and %d more' % (len(moved) - 14))
            self.failures.append((self.label, name, moved))
        else:
            extra = ('  (%d below the floor moved, as allowed)' % len(allowed)) if allowed else ''
            self.lines.append('  ok        %-54s  %s, page %dpx (%+d)%s'
                              % (name, floor_txt, cur['pageHeight'], dh, extra))
        if note:
            self.lines.append('            note: %s' % note)
        self.prev = cur


def click(page, sel):
    """aria-disabled is this brand's grammar for "unavailable but reachable",
    and Playwright reads it as not-enabled, so every click here is forced."""
    return lambda: page.click(sel, force=True)


MAKE_FILE = """() => {
  const dt = new DataTransfer();
  dt.items.add(new File([new Uint8Array([37,80,68,70,45,49,46,52,10])],
    'statement-2024.pdf', {type: 'application/pdf'}));
  const i = document.getElementById('file-docs');
  i.files = dt.files;
  i.dispatchEvent(new Event('change', {bubbles: true}));
}"""


def run(page, url, width, height):
    page.set_viewport_size({'width': width, 'height': height})
    page.goto(url)
    page.wait_for_selector('#screen-open:not([hidden])')
    page.wait_for_timeout(800)

    a = Audit(page, '%dpx' % width)
    a.lines.append('── the flow, step by step ' + '─' * 47)
    a.step('step 1, as it opens')
    a.step('open the CSV hatch', click(page, '#btn-hatch'), floor='paste',
           note='the hatch itself, and everything above it, must be still')
    a.step('close the CSV hatch', click(page, '#btn-hatch'), floor='paste')
    a.step('to step 2', click(page, '#go-prepare'), floor='screen')
    a.step('open the question box', click(page, '#btn-ask'), floor='ask')
    a.step('close the question box', click(page, '#btn-ask'), floor='ask')
    a.step('type a target year', lambda: (page.fill('#target-year-2', '2050'),
                                          page.dispatch_event('#target-year-2', 'change')),
           floor='#prepare-note',
           note='the note under the field is the only thing that may change')
    a.step('to step 3', click(page, '#go-upload'), floor='screen')
    a.step('add a document', lambda: page.evaluate(MAKE_FILE), floor='files', settle=400,
           note='the file list grows below everything; the drop target and both buttons are still')
    a.mark('step 3 with a file')

    a.lines.append('── Claude reads them ' + '─' * 52)
    a.step('to step 4 and let it read', lambda: (page.click('#go-read', force=True),
                                                 page.wait_for_selector('#go-answer:not([hidden])', timeout=30000)),
           floor='screen', settle=600)
    a.step('open the flag list', click(page, '#panel-flags summary'), floor='flags')
    a.step('close the flag list', click(page, '#panel-flags summary'), floor='flags')
    a.step('to step 5', click(page, '#go-answer'), floor='screen')
    a.mark('first question')
    # The LAST answer, deliberately: several first answers take you straight to
    # the row they are about ("let me correct it"), which is a screen change
    # and is audited elsewhere. This one stays on step 5, which is where the
    # question-replaces-question transition can be measured.
    a.step('answer it', click(page, '#panel-question .q-acts button:last-child'),
           floor='question', settle=300,
           note='a new question replaces the old one inside the same panel')
    a.step('back one', click(page, '#btn-q-back'), floor='question', against='first question')

    a.lines.append('── the table, the check, the result ' + '─' * 37)
    # Answer the rest, then go to the table however we got there.
    def finish_questions():
        for _ in range(50):
            if page.evaluate("() => document.getElementById('screen-answer').hidden"):
                return
            b = page.query_selector('#panel-question .q-acts button')
            if not b:
                return
            b.click()
            page.wait_for_timeout(90)
    a.step('answer the rest', finish_questions, floor='screen', settle=500)
    a.step('to step 6', click(page, '#step-rows'), floor='screen', settle=400)
    a.mark('the table, as left')
    a.step('open the data notes', click(page, '#btn-dq'), floor='dq')
    a.step('close the data notes', click(page, '#btn-dq'), floor='dq')
    a.step('add a second reference', click(page, '#ref-US_500'), floor='#gate-note',
           note='STRICT above the gate note: choosing a reference changes what will be '
                'sent, and the note under the button is the only thing that may say so')
    a.step('add a row', click(page, '#btn-addrow'), floor='rows',
           note='rows above the new one, and all of zone A, must be still')
    a.step('break the new row’s date',
           lambda: (page.fill('#tbody tr:last-child [data-field="date"]', '2024-02-30'),
                    page.dispatch_event('#tbody tr:last-child [data-field="date"]', 'change')),
           note='STRICT: an error marker is a fixed-size cell that only changes visibility')
    a.step('delete it again', click(page, '#tbody tr:last-child .del-btn'), floor='rows')
    a.step('to step 7', click(page, '#btn-compute'), floor='screen', settle=1500)
    a.step('open the six checks', click(page, '#panel-check summary'), floor='check')
    a.step('close the six checks', click(page, '#panel-check summary'), floor='check')
    a.step('to step 9', click(page, '#go-dash'), floor='screen', settle=1200)
    a.mark('the value chart')
    a.step('add a reference', click(page, '#v1-ref-US_500'), floor='v1caut', settle=600)
    a.step('switch to the log scale', click(page, '#scale-toggle'), floor='v1note', settle=600)
    a.step('crosshair on the plot', lambda: page.hover('svg.chart rect[style*="crosshair"]'), settle=250,
           note='STRICT: a crosshair moves nothing')
    a.step('off the plot', lambda: page.mouse.move(4, 4), settle=250)
    a.step('back to dollars', click(page, '#scale-toggle'), floor='v1note', settle=600)
    a.step('to what you kept', click(page, '#view-kept'), floor='v2caut', settle=900)
    a.step('open how it was worked out', click(page, '.scale-note-fold summary'), floor='v2caut')
    a.step('close it', click(page, '.scale-note-fold summary'), floor='v2caut')
    a.step('back to the value chart', click(page, '#view-value'), floor='v1caut', settle=900,
           against='the value chart',
           note='the chart must come back exactly as it was left')

    a.lines.append('── back to the table, and out ' + '─' * 43)
    a.step('back to step 6', click(page, '#step-rows'), floor='screen', settle=500,
           against='the table, as left',
           note='getting back to correct a row must cost nothing — not the rows, '
                'not the answers, not the position of the row you were about to click')
    a.step('to step 10', lambda: (page.click('#step-dash', force=True),
                                  page.wait_for_timeout(500),
                                  page.click('#step-save', force=True)),
           floor='screen', settle=500)
    return a


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument('--file', default=str(HERE / 'flow.html'))
    ap.add_argument('--width', nargs='*', type=int, default=[1280, 640])
    args = ap.parse_args()

    url = pathlib.Path(args.file).resolve().as_uri()
    all_lines, all_fail, errors = [], [], []
    with sync_playwright() as p:
        browser = p.chromium.launch()
        ctx = browser.new_context(device_scale_factor=1)
        page = ctx.new_page()
        page.on('pageerror', lambda e: errors.append('pageerror: ' + str(e)))
        page.on('console', lambda m: errors.append('console.%s: %s' % (m.type, m.text))
                if m.type == 'error' else None)
        for w in args.width:
            a = run(page, url, w, 900)
            all_lines += ['', '════ %dpx ═════════════════════════════════════════' % w] + a.lines
            all_fail += a.failures
        browser.close()

    print('LAYOUT STABILITY AUDIT — %s' % pathlib.Path(args.file).name)
    print('tolerance %.1fpx, boxes in document coordinates' % TOL)
    print('rule: zone A (A:*) never moves, on any transition. Zone B (B:*) may')
    print('      move only below the floor a transition declares; "strict" means')
    print('      no floor, so nothing on the page may move at all.')
    for line in all_lines:
        print(line)
    print('')
    if errors:
        print('PAGE ERRORS: %d' % len(errors))
        for e in errors[:10]:
            print('  ' + e)
    if all_fail or errors:
        print('RESULT: FAIL — %d transition(s) moved something the user aims at' % len(all_fail))
        for label, name, moved in all_fail:
            worst = max(moved, key=lambda m: max(abs(v) for v in m[1]))
            print('  %s  %-46s  worst: %s by %.1fpx'
                  % (label, name, worst[0], max(abs(v) for v in worst[1])))
        return 1
    print('RESULT: PASS — zone A never moved on any of the nine screens or on any')
    print('        crossing between them, nothing in zone B moved above a declared')
    print('        floor, and step 6 came back from the dashboard as it was left')
    return 0


if __name__ == '__main__':
    sys.exit(main())
