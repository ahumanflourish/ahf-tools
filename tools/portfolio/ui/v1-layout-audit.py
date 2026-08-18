#!/usr/bin/env python3
"""
v1-layout-audit.py — prove that the user's click targets do not move.

The defect this exists to catch: content that appears or disappears (caution
strips, cap notices, per-row reasons, a legend that grows a row per series, a
lede that rewrites itself) reflows everything below it. The chart moves. The
checkboxes move. Someone who clicks twice in the same place hits two different
things.

So: record the document-space bounding box of every interactive element and of
the plot area, walk a realistic sequence of state changes, and after each one
re-measure and diff. Any movement of a control or of the plot area is a
failure, named, with the pixel delta.

Boxes are measured in DOCUMENT coordinates (viewport rect + scroll offset) so
that a popover which scrolls itself into view does not register as everything
else moving.

Usage:  python3 v1-layout-audit.py [--file v1.html] [--width 1280 640]
Exit code 0 = pass, 1 = fail.
"""
import argparse
import json
import pathlib
import sys

from playwright.sync_api import sync_playwright

HERE = pathlib.Path(__file__).resolve().parent
TOL = 0.5  # px. Sub-pixel text metrics move by less than this; a reflow does not.

# Reading every tracked box in one evaluate keeps the measurement atomic.
PROBE = r"""
() => {
  const doc = document.documentElement;
  const sx = window.scrollX, sy = window.scrollY;
  const box = el => {
    const r = el.getBoundingClientRect();
    return [r.left + sx, r.top + sy, r.width, r.height];
  };
  const out = {};

  /* every checkbox and its label */
  document.querySelectorAll('.ref-label input').forEach(i => {
    out['checkbox ' + i.id] = box(i);
    out['label ' + i.id] = box(i.closest('.ref-label'));
  });
  /* every (i) and every warning triangle */
  document.querySelectorAll('.ref-pop-btn').forEach(b => {
    out['button "' + b.getAttribute('aria-label') + '"'] = box(b);
  });
  /* the other real controls */
  document.querySelectorAll('button[id], summary, .choice').forEach(b => {
    const name = b.id ? ('control #' + b.id) : ('control ' + (b.textContent || '').trim().slice(0, 30));
    if (!b.classList.contains('ref-pop-btn')) out[name] = box(b);
  });

  /* the chart: the svg, and the plot area proper — the interactive hit
     rectangle the crosshair reads, which is the drawn area itself */
  const svg = document.querySelector('svg.chart');
  if (svg) {
    out['chart svg'] = box(svg);
    const hit = svg.querySelector('rect[style*="crosshair"]');
    if (hit) out['plot area'] = box(hit);
  }
  return { boxes: out, pageHeight: doc.scrollHeight };
}
"""


class Audit:
    def __init__(self, page, width, label):
        self.page = page
        self.width = width
        self.label = label
        self.prev = None
        self.prev_name = None
        self.failures = []
        self.lines = []

    def measure(self):
        return self.page.evaluate(PROBE)

    def step(self, name, action=None, expect_still=True):
        if action:
            action()
            self.page.wait_for_timeout(90)
        cur = self.measure()
        if self.prev is None:
            self.lines.append(
                "  baseline  %-52s  %d tracked boxes, page %dpx"
                % (name, len(cur["boxes"]), cur["pageHeight"])
            )
        else:
            moved = []
            for key, b in cur["boxes"].items():
                a = self.prev["boxes"].get(key)
                if a is None:
                    moved.append((key, "appeared", None))
                    continue
                d = [round(b[i] - a[i], 2) for i in range(4)]
                if any(abs(v) > TOL for v in d):
                    moved.append((key, "moved", d))
            for key in self.prev["boxes"]:
                if key not in cur["boxes"]:
                    moved.append((key, "vanished", None))

            dh = cur["pageHeight"] - self.prev["pageHeight"]
            if expect_still and moved:
                self.lines.append("  FAIL      %-52s  page %dpx (%+d)" % (name, cur["pageHeight"], dh))
                for key, kind, d in moved[:14]:
                    if kind == "moved":
                        self.lines.append(
                            "            %-46s dx %+.1f  dy %+.1f  dw %+.1f  dh %+.1f"
                            % (key, d[0], d[1], d[2], d[3])
                        )
                    else:
                        self.lines.append("            %-46s %s" % (key, kind))
                if len(moved) > 14:
                    self.lines.append("            … and %d more" % (len(moved) - 14))
                self.failures.append((self.label, name, moved))
            else:
                self.lines.append(
                    "  ok        %-52s  page %dpx (%+d)" % (name, cur["pageHeight"], dh)
                )
        self.prev = cur
        self.prev_name = name


def run(page, url, width, height, strategy_ids):
    page.set_viewport_size({"width": width, "height": height})
    page.goto(url)
    page.wait_for_selector("svg.chart")
    page.wait_for_timeout(400)

    a = Audit(page, width, "%dpx" % width)
    a.lines.append("")
    a.lines.append("VIEWPORT %dx%d" % (width, height))

    def click_box(sid):
        return lambda: page.click("#ref-" + sid, force=True)

    a.step("load, default selection")

    # select each strategy in turn
    for sid in strategy_ids:
        checked = page.eval_on_selector("#ref-" + sid, "e => e.checked")
        disabled = page.eval_on_selector("#ref-" + sid, "e => e.disabled")
        if disabled:
            a.lines.append("  skip      %-52s  (checkbox disabled)" % ("select " + sid))
            continue
        if checked:
            a.step("deselect %s" % sid, click_box(sid))
            a.step("re-select %s" % sid, click_box(sid))
        else:
            a.step("select %s" % sid, click_box(sid))

    # everything on -> everything off, one at a time
    for sid in strategy_ids:
        if page.eval_on_selector("#ref-" + sid, "e => e.disabled"):
            continue
        if page.eval_on_selector("#ref-" + sid, "e => e.checked"):
            a.step("deselect %s" % sid, click_box(sid))

    a.step("select three at once", lambda: [page.click("#ref-" + s, force=True) for s in strategy_ids[:3]])

    # popovers
    info = page.query_selector_all('.ref-pop-btn:not(.is-caution)')
    if info:
        a.step("open an (i) popover", lambda: info[2 if len(info) > 2 else 0].click())
        a.step("close it (Escape)", lambda: page.keyboard.press("Escape"))
    caut = page.query_selector_all('.ref-pop-btn.is-caution')
    if caut:
        a.step("open a caution popover", lambda: caut[0].click())
        a.step("close it (click outside)", lambda: page.click("h1", force=True))

    # contributions & withdrawals
    a.step("contributions & withdrawals off", lambda: page.click("#ref-MONEY_IN", force=True))
    a.step("contributions & withdrawals on", lambda: page.click("#ref-MONEY_IN", force=True))

    # data-quality disclosure, if the page has one
    if page.query_selector("#dq-toggle"):
        a.step("open the data-quality notes", lambda: page.click("#dq-toggle"))
        a.step("close them", lambda: page.click("#dq-toggle"))

    # table view
    a.step("table view on", lambda: page.click("#table-toggle"))
    a.step("table view off", lambda: page.click("#table-toggle"))

    # select all seven
    def all_on():
        for s in strategy_ids:
            if not page.eval_on_selector("#ref-" + s, "e => e.disabled") \
               and not page.eval_on_selector("#ref-" + s, "e => e.checked"):
                page.click("#ref-" + s, force=True)
    a.step("select every strategy", all_on)
    a.step("deselect the first", click_box(strategy_ids[0]))
    a.step("re-select the first", click_box(strategy_ids[0]))

    return a


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--file", default=str(HERE / "v1.html"))
    ap.add_argument("--width", nargs="*", type=int, default=[1280, 640])
    args = ap.parse_args()

    url = pathlib.Path(args.file).resolve().as_uri()
    all_lines, all_fail = [], []
    with sync_playwright() as p:
        browser = p.chromium.launch()
        ctx = browser.new_context(device_scale_factor=1)
        page = ctx.new_page()
        page.goto(url)
        page.wait_for_selector("svg.chart")
        ids = page.evaluate(
            "() => Array.from(document.querySelectorAll('#refs .ref-label input')).map(i => i.id.replace('ref-',''))"
        )
        for w in args.width:
            a = run(page, url, w, 900, ids)
            all_lines += a.lines
            all_fail += a.failures
        browser.close()

    print("LAYOUT STABILITY AUDIT — %s" % pathlib.Path(args.file).name)
    print("tolerance %.1fpx, boxes in document coordinates" % TOL)
    for line in all_lines:
        print(line)
    print("")
    if all_fail:
        print("RESULT: FAIL — %d transition(s) moved something the user aims at" % len(all_fail))
        for label, name, moved in all_fail:
            worst = max(
                (m for m in moved if m[1] == "moved"),
                key=lambda m: max(abs(v) for v in m[2]),
                default=None,
            )
            if worst:
                print("  %s  %-40s  worst: %s by %.1fpx"
                      % (label, name, worst[0], max(abs(v) for v in worst[2])))
            else:
                print("  %s  %-40s  %s" % (label, name, moved[0][1]))
        return 1
    print("RESULT: PASS — no interactive element and no plot area moved in any transition")
    return 0


if __name__ == "__main__":
    sys.exit(main())
