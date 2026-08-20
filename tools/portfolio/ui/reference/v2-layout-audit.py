#!/usr/bin/env python3
"""
v2-layout-audit.py — prove that the user's click targets do not move.

Adapted from v1-layout-audit.py, same defect and same method: record the
document-space bounding box of every interactive element and of the plot area,
walk a realistic sequence of state changes, re-measure after each one, and fail
on any movement, named, with the pixel delta.

V2 has a harder version of the problem than V1 did. Its headline claim is
state-dependent BY DESIGN — the tool must be able to say "you did fine", and
"You finished $1,744 ahead of Global 60/40." is a different length from "You
gave up $6,638 of the available gain." — and that sentence sits ABOVE the bar,
because burying the punchline under the picture is not an option. The same goes
for the line under the bar, which names the reference. So this audit's real job
is to prove that the two reserved-height blocks (#claim and #under) are in fact
reserved: that switching to a longer or shorter wording, and switching the fee
input, moves neither the bar nor a single control.

It also walks the states V1 never had:
  · every reference in turn, including the two the user BEAT
  · the fee input at 0.85% and at 0, which changes the bar from three
    segments to two
  · a caution appearing and disappearing (three of the seven carry one)

What is deliberately NOT tracked: the bar's segments. They are data, not
controls — their position IS the information — so they are not focusable and
nothing is aimed at them. The tooltip they drive is hover-only, and everything
it says is also in the table view and in the accessible description.

Boxes are measured in DOCUMENT coordinates (viewport rect + scroll offset) so
that a popover which scrolls itself into view does not register as everything
else moving.

Usage:  python3 v2-layout-audit.py [--file v2.html] [--width 1280 640]
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
  const doc = document.documentElement;
  const sx = window.scrollX, sy = window.scrollY;
  const box = el => {
    const r = el.getBoundingClientRect();
    return [r.left + sx, r.top + sy, r.width, r.height];
  };
  const out = {};

  /* every radio — references and the fee input — and its label */
  document.querySelectorAll('.ref-label input').forEach(i => {
    out['radio ' + i.id] = box(i);
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

  /* the bar: the svg itself is the plot area — it has a fixed height at every
     state and every width, and it is the thing the tooltip reads */
  const svg = document.querySelector('svg.bar');
  if (svg) out['plot area (svg.bar)'] = box(svg);

  /* the two reserved blocks, tracked so a failure names the culprit rather
     than reporting fourteen things moving at once */
  const claim = document.getElementById('claim');
  if (claim) out['reserved #claim'] = box(claim);
  const under = document.getElementById('under');
  if (under) out['reserved #under'] = box(under);

  return { boxes: out, pageHeight: doc.scrollHeight };
}
"""


class Audit:
    def __init__(self, page, label):
        self.page = page
        self.label = label
        self.prev = None
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


def run(page, url, width, height, strategy_ids):
    page.set_viewport_size({"width": width, "height": height})
    page.goto(url)
    page.wait_for_selector("svg.bar")
    page.wait_for_timeout(500)

    a = Audit(page, "%dpx" % width)
    a.lines.append("")
    a.lines.append("VIEWPORT %dx%d" % (width, height))

    def pick(sid):
        return lambda: page.click("#ref-" + sid, force=True)

    a.step("load, default reference")

    # every reference in turn, at the fee as entered
    for sid in strategy_ids:
        if page.eval_on_selector("#ref-" + sid, "e => e.disabled"):
            a.lines.append("  skip      %-52s  (radio disabled)" % ("select " + sid))
            continue
        a.step("reference -> %s" % sid, pick(sid))

    # the two the user BEAT, back to back with one they did not: this is the
    # transition that rewrites the claim from "you gave up" to "you finished
    # ahead" and drops a whole segment off the bar
    a.step("reference -> GLOBAL_6040 (outperformed)", pick("GLOBAL_6040"))
    a.step("reference -> US_500 (worst gap)", pick("US_500"))
    a.step("reference -> ALL_BONDS (outperformed, biggest surplus)", pick("ALL_BONDS"))
    a.step("reference -> GLOBAL_EQUITY (default)", pick("GLOBAL_EQUITY"))

    # the fee input: three segments -> two
    a.step("fee -> 0% (two segments)", lambda: page.click("#fee-zero", force=True))
    a.step("fee -> 0.85% (three segments)", lambda: page.click("#fee-entered", force=True))
    a.step("fee -> 0% while outperforming", lambda: (page.click("#ref-ALL_BONDS", force=True),
                                                     page.click("#fee-zero", force=True)))
    a.step("back to the default state", lambda: (page.click("#ref-GLOBAL_EQUITY", force=True),
                                                 page.click("#fee-entered", force=True)))

    # a caution appearing and disappearing
    a.step("reference -> TARGET_2060 (caution appears)", pick("TARGET_2060"))
    a.step("reference -> GLOBAL_8020 (caution goes)", pick("GLOBAL_8020"))

    # popovers
    info = page.query_selector_all('.ref-pop-btn:not(.is-caution)')
    if info:
        a.step("open an (i) popover", lambda: info[2 if len(info) > 2 else 0].click())
        a.step("close it (Escape)", lambda: page.keyboard.press("Escape"))
    caut = page.query_selector_all('.ref-pop-btn.is-caution')
    if caut:
        a.step("open a caution popover", lambda: caut[0].click())
        a.step("close it (click outside)", lambda: page.click("h1", force=True))

    # data-quality disclosure
    if page.query_selector("#dq-toggle"):
        a.step("open the data-quality notes", lambda: page.click("#dq-toggle"))
        a.step("close them", lambda: page.click("#dq-toggle"))

    # table view
    a.step("table view on", lambda: page.click("#table-toggle"))
    a.step("switch reference with the table open", pick("US_500"))
    a.step("switch fee with the table open", lambda: page.click("#fee-zero", force=True))
    a.step("table view off", lambda: page.click("#table-toggle"))

    # and back round once more, so the last transition is not the only clean one
    a.step("reference -> GLOBAL_EQUITY", pick("GLOBAL_EQUITY"))
    a.step("fee -> 0.85%", lambda: page.click("#fee-entered", force=True))

    return a


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--file", default=str(HERE / "v2.html"))
    ap.add_argument("--width", nargs="*", type=int, default=[1280, 640])
    args = ap.parse_args()

    url = pathlib.Path(args.file).resolve().as_uri()
    all_lines, all_fail = [], []
    with sync_playwright() as p:
        browser = p.chromium.launch()
        ctx = browser.new_context(device_scale_factor=1)
        page = ctx.new_page()
        page.goto(url)
        page.wait_for_selector("svg.bar")
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
                print("  %s  %-46s  worst: %s by %.1fpx"
                      % (label, name, worst[0], max(abs(v) for v in worst[2])))
            else:
                print("  %s  %-46s  %s" % (label, name, moved[0][1]))
        return 1
    print("RESULT: PASS — no control, no reserved block and no plot area moved in any transition")
    return 0


if __name__ == "__main__":
    sys.exit(main())
