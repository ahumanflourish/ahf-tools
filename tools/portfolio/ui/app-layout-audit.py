#!/usr/bin/env python3
"""
app-layout-audit.py — prove that the user's click targets do not move, across
the whole tool rather than one screen of it.

Adapted from table-layout-audit.py, which was itself adapted from
v1-layout-audit.py. Same defect throughout: content that appears or disappears
reflows everything below it, the controls move, and someone who clicks twice
in the same place hits two different things. The assembled app is the hardest
version of it, because the three screens that used to be three files now share
one masthead, one step strip and one card head, and the reader crosses between
them mid-task — entry, compute, chart, bar, and back to the table to fix a row.
A transition that was previously impossible, because the screens were separate
documents, is now the most common one there is.

═══ THE RULE, IN TWO PARTS ═══════════════════════════════════════════════

ZONE A — every control the reader comes back to, on whichever screen is
showing, plus the three blocks that are shared by all of them: the masthead,
the step strip and the card head.

    On the ENTRY screen: the entry paths, the privacy notice, the toolbar,
    the running summary, the strategy picker, the fee and target-year fields,
    and the compute gate.

    On the RESULTS screen: the three chart actions, the rail — which sits
    above the cautions at every width, exactly as V1 argued it must — and the
    plot area itself, together with V2's two reserved blocks, the claim above
    the bar and the line beneath it.

    ZONE A NEVER MOVES. Not for any transition, not by a pixel, not ever.

That is checked on EVERY step below regardless of what the step did, and any
movement is an unconditional failure. It includes the card head's HEIGHT: it
reserves the tallest title-and-lede of the three steps, so moving between
steps must swap text inside a box whose size was already decided.

ZONE B — what answers back. The table and its panels on the entry screen; the
cautions, the note, the data notes, the table view and the footer meta line on
the results screen. Growth is allowed here and confined here, under the
FLOOR RULE:

    a transition declares a FLOOR — the element at the point of change. Any
    box whose top edge was ABOVE that floor before the transition must not
    move. Boxes at or below the floor may.

So: adding a row declares the floor at that row, and the rows above it, the
table header and all of zone A must be still. Opening the data notes declares
the floor at the data-notes panel, and everything above — including every row
of the table — must be still. Switching the reference the capture bar is
measured against declares the floor at the cautions, because a reference that
carries one grows a strip there; the bar, the claim, the line under it and
every radio in the rail must not move by so much as a sub-pixel.

Steps with NO floor are checked strictly: nothing on the page may move at all.
Validation is deliberately in that category, and so is every transition on the
results screen that is not a disclosure — selecting a strategy, switching the
scale, hovering the crosshair. A row's error marker is a fixed-size cell that
is always in the layout and only ever changes visibility, and its text lives
in an absolutely-positioned popover and in a panel below the table, so three
simultaneous errors appearing must move NOTHING, anywhere.

═══ TWO THINGS THIS FILE HAS THAT ITS ANCESTORS DID NOT ══════════════════

CHANGING SCREEN. A box that is not rendered is not measured, so the entry
screen's table simply drops out of the map while the chart is showing and
comes back when it returns. That is what makes the crossing checkable at all:
on the transition itself, the only boxes present in both measurements are the
shared ones — masthead, step strip, card head — and those are exactly the ones
that must be still. The floor for a screen change is the top of the screen
container, so nothing above it is allowed to move for any reason.

COMPARING AGAINST A NAMED EARLIER STATE. `mark(name)` saves a measurement;
`step(..., against=name)` diffs against that one instead of the immediately
previous. Going to the results and coming back is then checked against the
table AS IT WAS LEFT, which is the only way to state the requirement that
matters: getting back to the table to correct something must not cost you
anything — not your rows, not your answers, and not the position of the row
you were about to click.

Boxes are measured in DOCUMENT coordinates (viewport rect + scroll offset) so
that a popover which scrolls itself into view does not register as everything
else moving.

Usage:  python3 app-layout-audit.py [--file app.html] [--width 1280 640]
Exit code 0 = pass, 1 = fail.
"""
import argparse
import pathlib
import sys

from playwright.sync_api import sync_playwright

HERE = pathlib.Path(__file__).resolve().parent
TOL = 0.5  # px. Sub-pixel text metrics move by less than this; a reflow does not.

# One evaluate, so the measurement is atomic. Every box is named with its zone,
# because the zone is what decides whether movement is a defect. A box with no
# rendered area is not recorded at all: the hidden screen's controls are not
# "at the origin", they are not on the page.
PROBE = r"""
() => {
  const sx = window.scrollX, sy = window.scrollY;
  const rendered = el => {
    const r = el.getBoundingClientRect();
    return r.width > 0 || r.height > 0;
  };
  const box = el => {
    const r = el.getBoundingClientRect();
    return [r.left + sx, r.top + sy, r.width, r.height];
  };
  const out = {};
  const put = (name, el) => { if (el && rendered(el)) out[name] = box(el); };

  /* ── ZONE A: shared by every screen ───────────────────────────────── */
  put('A:masthead', document.querySelector('.masthead'));
  put('A:h1', document.querySelector('.head h1'));
  put('A:steps', document.getElementById('steps'));
  document.querySelectorAll('#steps button').forEach(b => put('A:step ' + b.id, b));
  /* The card head is measured with its height, which is the whole point of
     reserving it: the title and the lede change on every step. */
  put('A:card-head', document.getElementById('card-head'));

  /* ── ZONE A: the entry screen ─────────────────────────────────────── */
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
  put('A:field #target-year', document.getElementById('target-year'));
  put('A:btn #year-info', document.getElementById('year-info'));
  document.querySelectorAll('#summary .slot').forEach((s, i) => put('A:slot ' + i, s));

  /* ── ZONE A: the results screen ───────────────────────────────────── */
  put('A:results-head', document.getElementById('results-head'));
  document.querySelectorAll('#results-head .choice').forEach(b => put('A:btn ' + b.id, b));
  /* The two rails. Every radio and checkbox is named by its own id, and every
     popover button by the control it belongs to, so a caution strip appearing
     under one of them cannot re-map the names of the others. */
  ['v1-refs', 'v1-context', 'v2-refs'].forEach(id => {
    const host = document.getElementById(id);
    if (!host) return;
    put('A:rail ' + id, host);
    host.querySelectorAll('input').forEach(i => {
      put('A:input ' + i.id, i);
      put('A:label ' + i.id, i.closest('.ref-label'));
    });
    host.querySelectorAll('.pop-btn').forEach(b => {
      /* Namespaced by the rail. Both rails offer the same strategies, so
         `aria-label` alone is not a unique name across the two of them, and
         an un-namespaced one would compare V1's button against V2's on the
         crossing and report a move that never happened. */
      put('A:pop ' + id + ' "' + b.getAttribute('aria-label') + '"', b);
    });
  });
  /* The plots. The svg, and for V1 the hit rectangle the crosshair reads —
     which is the drawn area proper, and the thing a pointer is aimed at. */
  const chart = document.querySelector('svg.chart');
  if (chart) {
    put('A:v1 svg', chart);
    put('A:v1 plot area', chart.querySelector('rect[style*="crosshair"]'));
  }
  put('A:v2 svg', document.querySelector('svg.bar'));
  /* V2's two reserved blocks, tracked by name so a failure says which one
     stopped being reserved rather than reporting fourteen things at once. */
  put('A:reserved #v2-claim', document.getElementById('v2-claim'));
  put('A:reserved #v2-under', document.getElementById('v2-under'));

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
  ['panel-transfers', 'panel-problems', 'panel-paste', 'panel-dq', 'panel-extract',
   'panel-result'].forEach(id => {
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

  /* ── ZONE B: what answers back on the results screen ─────────────── */
  ['v1-cautions', 'v1-scale-note', 'v2-cautions', 'v2-note'].forEach(id => put('B:' + id, document.getElementById(id)));
  const rdq = document.getElementById('rdq-panel');
  if (rdq && !rdq.hidden) put('B:rdq-panel', rdq);
  const rt = document.getElementById('results-table');
  if (rt && !rt.hidden) put('B:results-table', rt);
  put('B:meta', document.getElementById('meta'));

  return { boxes: out, pageHeight: document.documentElement.scrollHeight };
}
"""

FLOORS = {
    'table':     '#tbl',
    'rows':      '#tbody',
    'transfers': '#panel-transfers',
    'problems':  '#panel-problems',
    'paste':     '#panel-paste',
    'dq':        '#panel-dq',
    'extract':   '#panel-extract',
    'legend':    '#legend',
    'result':    '#panel-result',
    'v1caut':    '#v1-cautions',
    'v1note':    '#v1-scale-note',
    'v2caut':    '#v2-cautions',
    'v2note':    '#v2-note',
    'rdq':       '#rdq-panel',
    'rtable':    '#results-table',
    'meta':      '#meta',
}

# The floor for a change of screen: the top of whichever screen container is
# showing. Above it live the masthead, the head, the step strip and the card
# head, and none of them may move for any reason, in either direction.
SCREEN_FLOOR = """() => {
  const a = document.getElementById('screen-entry');
  const b = document.getElementById('screen-results');
  const vis = e => e && e.getBoundingClientRect().height > 0;
  const e = vis(a) ? a : b;
  return e ? e.getBoundingClientRect().top + window.scrollY : Infinity;
}"""


def CONTAINER(key):
    """Zone-B boxes that are containers of other measured boxes."""
    if key.startswith('B:panel-') or key in ('B:table', 'B:legend', 'B:rdq-panel',
                                             'B:results-table', 'B:meta',
                                             'B:v1-cautions', 'B:v1-scale-note',
                                             'B:v2-cautions', 'B:v2-note'):
        return True
    parts = key.split(' ')
    return len(parts) == 2 and parts[0] == 'B:row'   # the <tr> itself


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
        """Remember the current state so a later step can be diffed against it."""
        self.marks[name] = self.prev
        self.lines.append('  mark      %-54s  remembered' % name)

    def floor_y(self, spec):
        """Document-space top edge of the declared floor, or +inf for strict."""
        if spec is None:
            return float('inf')
        if spec == 'screen':
            return self.page.evaluate(SCREEN_FLOOR)
        if isinstance(spec, (int, float)):
            return float(spec)
        sel = FLOORS.get(spec, spec)
        # A HIDDEN panel has a 0x0 rect, and a floor of 0 would wave the whole
        # page through. The floor for a panel that is about to open is where it
        # WILL open: the bottom of the last laid-out thing before it.
        #
        # An EMPTY one is a different case and must not be confused with it. A
        # grid area with nothing in it still has a width and still has a
        # position, and that position is exactly the point of change — the
        # cautions strip on the value chart is empty until a strategy that
        # carries one is chosen. So "laid out" here is the same test the probe
        # uses, width OR height, not height alone.
        return self.page.evaluate(
            """(sel) => {
                 const e = document.querySelector(sel);
                 if (!e) return Infinity;
                 const vis = x => {
                   if (!x) return false;
                   const r = x.getBoundingClientRect();
                   return r.width > 0 || r.height > 0;
                 };
                 if (vis(e)) return e.getBoundingClientRect().top + window.scrollY;
                 let p = e.previousElementSibling;
                 while (p && !vis(p)) p = p.previousElementSibling;
                 if (p) return p.getBoundingClientRect().bottom + window.scrollY;
                 return e.parentElement.getBoundingClientRect().top + window.scrollY;
               }""",
            sel,
        )

    def step(self, name, action=None, floor=None, note='', against=None, settle=110):
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
                # A box that was not rendered before cannot have moved. New
                # rows, new answer buttons, newly-shown panels and the whole of
                # the screen being arrived at all appear by design.
                continue
            d = [round(b[i] - a[i], 2) for i in range(4)]
            # What counts as movement: position, always, and width. HEIGHT is
            # movement for zone A — a zone-A block that grows is exactly the
            # defect this file exists to catch, and the card head and V2's two
            # reserved blocks are checked on it — but not for a zone-B
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


def cell(page, row, field):
    return '#tbody tr:nth-child(%d) [data-field="%s"]' % (row, field)


def type_into(page, row, field, value):
    def go():
        sel = cell(page, row, field)
        page.fill(sel, value)
        page.dispatch_event(sel, 'change')
    return go


def fill(page, sel, value):
    def go():
        page.fill(sel, value)
        page.dispatch_event(sel, 'change')
    return go


def bump_last_amount(page):
    """Edit the last row's amount by a dollar. Which row that is depends on
    what the run before it loaded, so it is found rather than counted."""
    def go():
        sel = '#tbody tr:last-child [data-field="amount"]'
        cur = page.eval_on_selector(sel, 'e => e.value')
        page.fill(sel, '%.2f' % (float(str(cur).replace(',', '') or 0) + 1))
        page.dispatch_event(sel, 'change')
    return go


# A history the log scale can actually draw: every value positive at every
# month, so the "unavailable" state is not the only one the scale toggle is
# ever audited in. Pasted rather than typed, which exercises path B on the way
# past and keeps the audit to one action per step.
LOG_SAFE_CSV = """date,type,amount
2015-01-30,contribution,25000
2015-01-30,balance,25000
2016-12-30,balance,29500
2018-12-31,balance,35200
2020-12-31,balance,44800
2022-12-30,balance,41900
2024-12-31,balance,58300
"""


def run(page, url, width, height):
    page.set_viewport_size({'width': width, 'height': height})
    page.goto(url)
    page.wait_for_selector('#tbody tr')
    page.wait_for_timeout(700)

    a = Audit(page, '%dpx' % width)
    a.lines.append('')
    a.lines.append('VIEWPORT %dx%d' % (width, height))
    a.lines.append('── the entry screen ' + '─' * 52)
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
    a.step('open the row popover', click(page, '#tbody tr:nth-child(2) .pop-btn'))
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

    # ── the target retirement year: the picker gains a reference ─────────
    # The one input on this screen that ADDS a control to zone A rather than
    # changing one, which makes it the hardest thing on it to keep still.
    a.step('a target retirement year, 2043', fill(page, '#target-year', '2043'),
           note='the picker grows a constructed target-date reference')
    a.step('open its constructed-reference caution',
           click(page, '#why-TARGET_DATE_2043'))
    a.step('close it (Escape)', lambda: page.keyboard.press('Escape'))
    a.step('select the constructed reference', click(page, '#ref-TARGET_DATE_2043'))
    a.step('change the year to 2060 — a real fund exists for it',
           fill(page, '#target-year', '2060'))
    a.step('an out-of-range year', fill(page, '#target-year', '3000'))
    a.step('clear the year', fill(page, '#target-year', ''))
    a.step('the target year again, for the run', fill(page, '#target-year', '2043'),
           note='changing the year drops a selection that belonged to the old one, '
                'so the constructed reference is chosen again below')
    a.step('re-select the constructed reference', click(page, '#ref-TARGET_DATE_2043'))

    # ── strategy selection changes the supported window and the copy ─────
    a.step('select a second strategy', click(page, '#ref-US_500'))
    a.step('select a third', click(page, '#ref-TARGET_2060'))
    a.step('deselect the default', click(page, '#ref-GLOBAL_EQUITY'))
    a.step('re-select the default', click(page, '#ref-GLOBAL_EQUITY'))
    a.step('change the fee', fill(page, '#fee', '0.85'))
    a.step('an out-of-range fee', fill(page, '#fee', '85'))
    a.step('fee back in range', fill(page, '#fee', '0.85'))

    # ── compute, and the crossing to the results ─────────────────────────
    a.lines.append('── the gate, and the crossing ' + '─' * 42)
    a.mark('entry')
    a.step('press the gate — the results screen arrives', click(page, '#btn-compute'),
           floor='screen', settle=900,
           note='only the masthead, the step strip and the card head exist in both')

    # ── V1: the portfolio-value chart ────────────────────────────────────
    a.lines.append('── V1, the value chart ' + '─' * 49)
    a.step('select a second line', click(page, '#v1-ref-US_500'), floor='v1caut', settle=400,
           note='a second line adds a rail row and may add a caution strip, both below the rail')
    a.step('select a third', click(page, '#v1-ref-TARGET_DATE_2043'), floor='v1caut', settle=400)
    a.step('deselect the first', click(page, '#v1-ref-GLOBAL_EQUITY'), floor='v1caut', settle=400)
    a.step('re-select it', click(page, '#v1-ref-GLOBAL_EQUITY'), floor='v1caut', settle=400)
    a.step('contributions & withdrawals off', click(page, '#v1-ref-MONEY_IN'), floor='v1caut', settle=400)
    a.step('and back on', click(page, '#v1-ref-MONEY_IN'), floor='v1caut', settle=400)
    a.step('open a rail (i) popover', click(page, '#v1-refs .ref:first-child .pop-btn'))
    a.step('close it (Escape)', lambda: page.keyboard.press('Escape'))
    a.step('open a rail caution', click(page, '#v1-refs .pop-btn.is-caution'))
    a.step('close it (Escape)', lambda: page.keyboard.press('Escape'))
    a.step('move the crosshair onto the plot',
           lambda: page.hover('svg.chart rect[style*="crosshair"]'), settle=200)
    a.step('move it along', lambda: page.mouse.move(width * 0.55, 420), settle=200)
    a.step('take it off the plot', lambda: page.mouse.move(4, 4), settle=200)
    a.step('the log scale, unavailable on this history',
           click(page, '#scale-toggle'), floor='v1note', settle=400,
           note='the toggle is aria-disabled and the note under the plot says which value forbids it')
    a.step('table view on', click(page, '#rtable-toggle'), floor='rtable', settle=300)
    a.step('table view off', click(page, '#rtable-toggle'), floor='rtable', settle=300)
    a.step('open the results data notes', click(page, '#rdq-toggle'), floor='rdq')
    a.step('close them', click(page, '#rdq-toggle'), floor='rdq')

    # ── V2: the capture bar ──────────────────────────────────────────────
    a.lines.append('── V2, the capture bar ' + '─' * 49)
    a.step('step 3 — the capture bar', click(page, '#step-v2'), floor='screen', settle=2600,
           note='same crossing, same three shared boxes')
    a.step('reference -> US 500', click(page, '#v2-ref-US_500'), floor='v2caut', settle=2600)
    a.step('reference -> the constructed 2043 fund',
           click(page, '#v2-ref-TARGET_DATE_2043'), floor='v2caut', settle=2600,
           note='a constructed reference, so its caution strip appears below the rail')
    a.step('reference -> back to the default',
           click(page, '#v2-ref-GLOBAL_EQUITY'), floor='v2caut', settle=2600)
    a.step('open a rail caution', click(page, '#v2-refs .pop-btn.is-caution'))
    a.step('close it (Escape)', lambda: page.keyboard.press('Escape'))
    a.step('table view on', click(page, '#rtable-toggle'), floor='rtable', settle=300)
    a.step('switch reference with the table open',
           click(page, '#v2-ref-US_500'), floor='v2caut', settle=2600)
    a.step('table view off', click(page, '#rtable-toggle'), floor='rtable', settle=300)
    a.step('open the results data notes', click(page, '#rdq-toggle'), floor='rdq')
    a.step('close them', click(page, '#rdq-toggle'), floor='rdq')
    a.step('back to the value chart', click(page, '#step-v1'), floor='screen', settle=900)

    # ── back to the table, and it must be exactly as it was left ─────────
    a.lines.append('── back to the table ' + '─' * 51)
    a.step('step 1 — the rows again', click(page, '#step-rows'), floor='screen', settle=500)
    a.step('every box on the entry screen is where it was left',
           against='entry',
           note='no floor: the trip to the results and back may not move one pixel of it')
    a.step('correct a row', bump_last_amount(page), floor='legend')
    a.step('back to the chart with a stale run',
           click(page, '#step-v1'), floor='screen', settle=900)
    a.step('the stale strip is up', None, floor='v1caut')
    a.step('back to the table again', click(page, '#step-rows'), floor='screen', settle=500)
    a.step('re-press the gate', click(page, '#btn-compute'), floor='screen', settle=900)

    # ── a history the log scale can draw ─────────────────────────────────
    a.lines.append('── the log scale, on a history it can draw ' + '─' * 30)
    a.step('back to the table', click(page, '#step-rows'), floor='screen', settle=500)
    a.step('open the paste panel', click(page, '#path-B'), floor='paste')
    a.step('paste an all-positive history',
           lambda: (page.fill('#paste-text', LOG_SAFE_CSV), page.click('#btn-parse', force=True)),
           floor='paste')
    a.step('put it in the table',
           click(page, '#parse-report .paste-acts .btn'), floor='rows')
    a.step('close the paste panel', click(page, '#path-A'), floor='paste')
    a.step('compute it', click(page, '#btn-compute'), floor='screen', settle=1200)
    a.step('switch to the log scale', click(page, '#scale-toggle'), floor='v1note', settle=600,
           note='the note rewrites itself to explain what the axis now means')
    a.step('add a line while on the log scale',
           click(page, '#v1-ref-US_500'), floor='v1caut', settle=500)
    a.step('crosshair on the log scale',
           lambda: page.hover('svg.chart rect[style*="crosshair"]'), settle=200)
    a.step('off the plot', lambda: page.mouse.move(4, 4), settle=200)
    a.step('back to dollars', click(page, '#scale-toggle'), floor='v1note', settle=600)

    # ── clear everything, from the results ───────────────────────────────
    a.lines.append('── and out ' + '─' * 61)
    a.step('back to the table', click(page, '#step-rows'), floor='screen', settle=500)
    a.step('clear everything', lambda: (page.click('#btn-clear', force=True),
                                        page.wait_for_timeout(60),
                                        page.click('#clear-wrap .pop-acts button:first-child', force=True)),
           floor='rows')
    return a


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument('--file', default=str(HERE / 'app.html'))
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
    print('RESULT: PASS — zone A never moved on either screen or across the crossing,')
    print('        nothing in zone B moved above a declared floor, and the entry screen')
    print('        came back from the results exactly as it was left')
    return 0


if __name__ == '__main__':
    sys.exit(main())
