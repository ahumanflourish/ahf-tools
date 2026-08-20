#!/usr/bin/env python3
"""
table-layout-audit.py — prove that the user's click targets do not move.

Adapted from v1-layout-audit.py. The defect is the same one: content that
appears or disappears reflows everything below it, the controls move, and
someone who clicks twice in the same place hits two different things. The
review table is a harder case than the chart, because here the content is the
point — rows are added and removed, validation flags light up, a transfer
question appears, a parse report unrolls. Some of that movement is legitimate.
Saying which, precisely, is the job of this file.

═══ THE RULE, IN TWO PARTS ═══════════════════════════════════════════════

ZONE A — everything from the masthead down to the compute gate, inclusive:
the three entry-path buttons, the privacy notice, the whole toolbar, the
running summary, the strategy picker, the fee field, the compute button and
its note. Every control the user comes back to lives here.

    ZONE A NEVER MOVES. Not for any transition, not by a pixel, not ever.

That is checked on EVERY step below regardless of what the step did, and any
movement is an unconditional failure.

ZONE B — the table and the panels beneath it. Growth is allowed here and
confined here, under the FLOOR RULE:

    a transition declares a FLOOR — the element at the point of change. Any
    box whose top edge was ABOVE that floor before the transition must not
    move. Boxes at or below the floor may.

So: adding a row declares the floor at that row, and the rows above it, the
table header and all of zone A must be still, while the rows below it move.
Opening the data notes declares the floor at the data-notes panel, and
everything above — including every row of the table — must be still.

Steps with NO floor are checked strictly: nothing on the page may move at
all. Validation is deliberately in that category. A row's error marker is a
fixed-size cell that is always in the layout and only ever changes
visibility, and its text lives in an absolutely-positioned popover and in a
panel below the table, so three simultaneous errors appearing must move
NOTHING, anywhere. If that ever stops being true this file fails.

Boxes are measured in DOCUMENT coordinates (viewport rect + scroll offset) so
that a popover which scrolls itself into view does not register as everything
else moving.

Usage:  python3 table-layout-audit.py [--file table.html] [--width 1280 640]
Exit code 0 = pass, 1 = fail.
"""
import argparse
import pathlib
import sys

from playwright.sync_api import sync_playwright

HERE = pathlib.Path(__file__).resolve().parent
TOL = 0.5  # px. Sub-pixel text metrics move by less than this; a reflow does not.

# One evaluate, so the measurement is atomic. Every box is named with its zone,
# because the zone is what decides whether movement is a defect.
PROBE = r"""
() => {
  const sx = window.scrollX, sy = window.scrollY;
  const box = el => {
    const r = el.getBoundingClientRect();
    return [r.left + sx, r.top + sy, r.width, r.height];
  };
  const out = {};
  const put = (name, el) => { if (el) out[name] = box(el); };

  /* ── ZONE A: every control above the table ───────────────────────── */
  put('A:paths', document.getElementById('paths'));
  put('A:privacy', document.getElementById('privacy'));
  put('A:toolbar', document.getElementById('toolbar'));
  put('A:summary', document.getElementById('summary'));
  put('A:gate-refs', document.getElementById('gate-refs'));
  put('A:gate-note', document.getElementById('gate-note'));
  document.querySelectorAll('#paths button, #toolbar button, #gate-refs button').forEach(b => {
    put('A:btn ' + (b.id || (b.textContent || '').trim().slice(0, 22)), b);
  });
  put('A:btn #btn-compute', document.getElementById('btn-compute'));
  put('A:field #fee', document.getElementById('fee'));
  document.querySelectorAll('#summary .slot').forEach((s, i) => put('A:slot ' + i, s));

  /* ── ZONE B: the table, then the panels ──────────────────────────── */
  put('B:table', document.getElementById('tbl'));
  put('B:thead', document.querySelector('#tbl thead tr'));
  /* Row controls are named by WHAT they are, never by their index: a popover
     opening inside a row inserts a button, and an index-named box would
     re-map and read as movement that never happened. */
  document.querySelectorAll('#tbody tr').forEach(tr => {
    const rid = tr.dataset.rid;
    put('B:row ' + rid, tr);
    put('B:row ' + rid + ' date', tr.querySelector('[data-field="date"]'));
    put('B:row ' + rid + ' amount', tr.querySelector('[data-field="amount"]'));
    tr.querySelectorAll('.seg button').forEach(b => put('B:row ' + rid + ' type ' + b.dataset.type, b));
    put('B:row ' + rid + ' flag', tr.querySelector('.c-tool > .pop-btn'));
    put('B:row ' + rid + ' del', tr.querySelector('.del-btn'));
  });
  put('B:addrow', document.getElementById('btn-addrow'));
  put('B:example', document.getElementById('btn-example'));
  ['panel-transfers', 'panel-problems', 'panel-paste', 'panel-dq', 'panel-result', 'meta'].forEach(id => {
    const e = document.getElementById(id);
    if (e && !e.hidden) put('B:' + id, e);
  });
  /* Same reasoning: an answer button is named by its panel, its card and its
     own words, so a card appearing above it does not re-map every other one. */
  ['panel-transfers', 'panel-problems'].forEach(pid => {
    const host = document.getElementById(pid);
    if (!host || host.hidden) return;
    host.querySelectorAll('.qcard').forEach((card, ci) => {
      card.querySelectorAll('.q-acts button').forEach(b => {
        put('B:' + pid + ' card ' + ci + ' "' + (b.textContent || '').trim().slice(0, 18) + '"', b);
      });
    });
  });
  put('B:legend', document.getElementById('legend'));

  return { boxes: out, pageHeight: document.documentElement.scrollHeight };
}
"""

FLOORS = {
    'table':    '#tbl',
    'rows':     '#tbody',
    'transfers': '#panel-transfers',
    'problems': '#panel-problems',
    'paste':    '#panel-paste',
    'dq':       '#panel-dq',
    'legend':   '#legend',
    'result':   '#panel-result',
}


def CONTAINER(key):
    """Zone-B boxes that are containers of other measured boxes."""
    if key.startswith('B:panel-') or key == 'B:table' or key == 'B:legend':
        return True
    parts = key.split(' ')
    return len(parts) == 2 and parts[0] == 'B:row'   # the <tr> itself


class Audit:
    def __init__(self, page, label):
        self.page = page
        self.label = label
        self.prev = None
        self.failures = []
        self.lines = []

    def measure(self):
        return self.page.evaluate(PROBE)

    def floor_y(self, spec):
        """Document-space top edge of the declared floor, or +inf for strict."""
        if spec is None:
            return float('inf')
        if isinstance(spec, (int, float)):
            return float(spec)
        sel = FLOORS.get(spec, spec)
        # A hidden panel has a zero rect, and a floor of 0 would wave the whole
        # page through. The floor for a panel that is about to open is where it
        # WILL open: the bottom of the last visible thing before it.
        return self.page.evaluate(
            """(sel) => {
                 const e = document.querySelector(sel);
                 if (!e) return Infinity;
                 const vis = x => x && x.getBoundingClientRect().height > 0;
                 if (vis(e)) return e.getBoundingClientRect().top + window.scrollY;
                 let p = e.previousElementSibling;
                 while (p && !vis(p)) p = p.previousElementSibling;
                 if (p) return p.getBoundingClientRect().bottom + window.scrollY;
                 return e.parentElement.getBoundingClientRect().top + window.scrollY;
               }""",
            sel,
        )

    def step(self, name, action=None, floor=None, note=''):
        floor_before = self.floor_y(floor) if floor is not None else float('inf')
        if action:
            action()
            self.page.wait_for_timeout(110)
        cur = self.measure()
        if self.prev is None:
            self.lines.append('  baseline  %-54s  %d boxes, page %dpx'
                              % (name, len(cur['boxes']), cur['pageHeight']))
            self.prev = cur
            return

        moved, allowed = [], []
        for key, b in cur['boxes'].items():
            a = self.prev['boxes'].get(key)
            if a is None:
                # A box that did not exist before cannot have moved. New rows,
                # new answer buttons and newly-shown panels appear by design.
                continue
            d = [round(b[i] - a[i], 2) for i in range(4)]
            # What counts as movement: position, always, and width. HEIGHT is
            # movement for zone A — a zone-A block that grows is exactly the
            # defect this file exists to catch — but not for a zone-B
            # container, whose height IS its content. Everything inside such a
            # container, and everything below it, is measured separately, so
            # nothing is lost by exempting the box itself.
            watch = d if (key.startswith('A:') or not CONTAINER(key)) else d[:3]
            if not any(abs(v) > TOL for v in watch):
                continue
            # Zone A is unconditional. Zone B is judged against the floor.
            if key.startswith('A:') or a[1] < floor_before - TOL:
                moved.append((key, d))
            else:
                allowed.append((key, d))

        dh = cur['pageHeight'] - self.prev['pageHeight']
        floor_txt = 'strict' if floor is None else ('floor %s @%.0f' % (floor, floor_before))
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


def cell(page, row, field):
    return '#tbody tr:nth-child(%d) [data-field="%s"]' % (row, field)


def type_into(page, row, field, value):
    def go():
        sel = cell(page, row, field)
        page.fill(sel, value)
        page.dispatch_event(sel, 'change')
    return go


def run(page, url, width, height):
    page.set_viewport_size({'width': width, 'height': height})
    page.goto(url)
    page.wait_for_selector('#tbody tr')
    page.wait_for_timeout(600)

    a = Audit(page, '%dpx' % width)
    a.lines.append('')
    a.lines.append('VIEWPORT %dx%d' % (width, height))
    a.step('load, two example rows')

    # ── typing. Nothing structural, so nothing at all may move. ──────────
    a.step('type a date into row 1', type_into(page, 1, 'date', '2021-12-31'))
    a.step('type an amount into row 1', type_into(page, 1, 'amount', '18000'))
    a.step('change row 1 to a contribution',
           click(page, '#tbody tr:nth-child(1) .seg button[data-type="contribution"]'))
    a.step('change row 1 back to a balance',
           click(page, '#tbody tr:nth-child(1) .seg button[data-type="balance"]'))

    # ── validation. Strict: a flag lighting up must move nothing at all. ──
    a.step('a malformed date appears (2024-1-5)', type_into(page, 2, 'date', '2024-1-5'))
    a.step('a second error: a date that rolls (2024-02-30)',
           lambda: (page.fill(cell(page, 1, 'date'), '2024-02-30'),
                    page.dispatch_event(cell(page, 1, 'date'), 'change')))
    a.step('a third error: a non-numeric amount', type_into(page, 2, 'amount', '12,000x'))
    a.step('all three cleared at once',
           lambda: [page.fill(cell(page, 1, 'date'), '2022-12-31'),
                    page.fill(cell(page, 2, 'date'), '2023-12-31'),
                    page.fill(cell(page, 2, 'amount'), '26000'),
                    page.dispatch_event(cell(page, 2, 'amount'), 'change')])

    # ── row popover. Absolutely positioned; opening it moves nothing. ─────
    a.step('a row flag appears', type_into(page, 2, 'date', '2099-01-01'))
    a.step('open the row popover',
           click(page, '#tbody tr:nth-child(2) .pop-btn'))
    a.step('close it (Escape)', lambda: page.keyboard.press('Escape'))
    a.step('clear the flag', type_into(page, 2, 'date', '2023-12-31'))

    # ── structural change. Floor at the table. ───────────────────────────
    a.step('add a row at the end', click(page, '#btn-addrow'), floor='rows')
    a.step('add another', click(page, '#btn-addrow'), floor='rows')
    a.step('delete the last row',
           click(page, '#tbody tr:last-child .del-btn'), floor='rows')
    a.step('delete the FIRST row — rows below it move, nothing above does',
           click(page, '#tbody tr:first-child .del-btn'), floor='rows')
    a.step('undo that delete', click(page, '#btn-undo'), floor='rows')

    # ── the eleven-row example: rows, transfers, markers, all at once ─────
    a.step('load the AI-extracted example', click(page, '#btn-example'), floor='rows')

    # ── the panels. Each declares its own floor. ─────────────────────────
    a.step('open the transfer question', click(page, '#btn-transfers'), floor='transfers')
    a.step('answer it — exclude both',
           click(page, '#panel-transfers .qcard:first-of-type .q-acts button:first-child'),
           floor='transfers')
    a.step('answer it the other way — keep both',
           click(page, '#panel-transfers .qcard:first-of-type .q-acts button:nth-child(2)'),
           floor='transfers')
    a.step('close the transfer question', click(page, '#btn-transfers'), floor='transfers')

    a.step('open the data notes', click(page, '#btn-dq'), floor='dq')
    a.step('close the data notes', click(page, '#btn-dq'), floor='dq')

    # Editing a row can add a marker the legend did not carry before, and the
    # legend is a wrapping line below the table's last control.
    a.step('a negative balance raises a question',
           type_into(page, 11, 'amount', '-34905.12'), floor='legend',
           note='the row gains an "edited" marker, so the legend grows a line')
    a.step('open the problems panel', click(page, '#btn-problems'), floor='problems')
    a.step('answer the negative-balance question',
           click(page, '#panel-problems .qcard .q-acts button:first-child'),
           floor='problems')
    # Answering the last question empties the panel, and an empty panel closes
    # itself — a change to a control's own disclosure, below the table.
    a.step('put the balance back', type_into(page, 11, 'amount', '34905.12'),
           floor='problems', note='the problems panel empties and closes itself')

    # ── path B: the paste panel, a parse report and an ambiguity ─────────
    a.step('open the paste panel', click(page, '#path-B'), floor='paste')
    a.step('parse a messy CSV', click(page, 'text=Load a messy example'), floor='paste')
    a.step('parse an ambiguous-date CSV',
           click(page, 'text=Load an ambiguous-date example'), floor='paste')
    a.step('commit one reading',
           click(page, '#panel-paste .reading:first-child .btn'), floor='rows')
    a.step('back to typing', click(page, '#path-A'), floor='paste')

    # ── popovers in zone A ───────────────────────────────────────────────
    a.step('open an entry-path popover', click(page, '#paths .path:nth-child(2) .pop-btn'))
    a.step('close it (Escape)', lambda: page.keyboard.press('Escape'))
    a.step('open the AI path caution', click(page, '#paths .path:nth-child(4) .pop-btn'))
    a.step('close it (Escape)', lambda: page.keyboard.press('Escape'))
    a.step('open the clear-everything confirm', click(page, '#btn-clear'))
    a.step('cancel it', click(page, '#clear-wrap .pop-acts button:nth-child(2)'))

    # ── strategy selection changes the supported window and the copy ─────
    a.step('select a second strategy', click(page, '#ref-US_500'))
    a.step('select a third', click(page, '#ref-TARGET_2060'))
    a.step('deselect the default', click(page, '#ref-GLOBAL_EQUITY'))
    a.step('re-select the default', click(page, '#ref-GLOBAL_EQUITY'))
    a.step('change the fee',
           lambda: (page.fill('#fee', '0.85'), page.dispatch_event('#fee', 'change')))
    a.step('an out-of-range fee', lambda: (page.fill('#fee', '85'),
                                           page.dispatch_event('#fee', 'change')))
    a.step('fee back in range', lambda: (page.fill('#fee', '0.85'),
                                         page.dispatch_event('#fee', 'change')))

    # ── compute, and the result panel ────────────────────────────────────
    a.step('press the gate', click(page, '#btn-compute'), floor='result')
    a.step('press it again', click(page, '#btn-compute'), floor='result')

    # ── clear everything ─────────────────────────────────────────────────
    a.step('clear everything', lambda: (page.click('#btn-clear', force=True),
                                        page.wait_for_timeout(60),
                                        page.click('#clear-wrap .pop-acts button:first-child', force=True)),
           floor='rows')
    return a


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument('--file', default=str(HERE / 'table.html'))
    ap.add_argument('--width', nargs='*', type=int, default=[1280, 640])
    args = ap.parse_args()

    url = pathlib.Path(args.file).resolve().as_uri()
    all_lines, all_fail, errors = [], [], []
    with sync_playwright() as p:
        browser = p.chromium.launch()
        ctx = browser.new_context(device_scale_factor=1)
        page = ctx.new_page()
        page.on('pageerror', lambda e: errors.append(str(e)))
        for w in args.width:
            a = run(page, url, w, 900)
            all_lines += a.lines
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
    print('RESULT: PASS — zone A never moved, and nothing in zone B moved above a declared floor')
    return 0


if __name__ == '__main__':
    sys.exit(main())
