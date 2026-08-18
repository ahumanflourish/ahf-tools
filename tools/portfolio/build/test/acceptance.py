#!/usr/bin/env python3
"""
Acceptance check for the two self-contained build targets.

This is the point of the pipeline, so it proves rather than asserts:

  1. Opens dist/html/portfolio-core.offline.html from a real ``file://`` URL in
     headless Chromium, in a browser context put into offline mode — if the
     page needed the network it could not get it.
  2. Calls ``analyse()`` in the page on the *bundled* fixture input and checks
     ``endingValue`` reproduces 53690.25 to the cent.
  3. Records every request the context issues and requires that the only one is
     the document itself. Anything else — a font, a favicon, an analytics
     beacon — fails the run.
  4. Loads the artifact payload into a blank page and checks it reproduces the
     same number with no module loader present.

The fixture's known-failing `regional-tilt` expectation is deliberately out of
scope here: this check is about the build, not the engine's finding rules.

Usage:  python3 test/acceptance.py
"""
import json
import pathlib
import sys

from playwright.sync_api import sync_playwright

BUILD_DIR = pathlib.Path(__file__).resolve().parent.parent
HTML = BUILD_DIR / "dist" / "html" / "portfolio-core.offline.html"
ARTIFACT = BUILD_DIR / "dist" / "artifact" / "portfolio-core.artifact.js"

EXPECTED_ENDING_VALUE = 53690.25
CENT = 0.005

failures = []
checks = 0


def check(ok, label, detail=""):
    global checks
    checks += 1
    print(("  PASS  " if ok else "  FAIL  ") + label + (f"  {detail}" if detail else ""))
    if not ok:
        failures.append(label + (f" — {detail}" if detail else ""))
    return ok


def main():
    for p in (HTML, ARTIFACT):
        if not p.exists():
            print(f"missing build output: {p}\nrun `npm run build` first", file=sys.stderr)
            return 2

    url = HTML.as_uri()
    print(f"target : {HTML}")
    print(f"url    : {url}")
    print(f"bytes  : {HTML.stat().st_size}\n")

    requests = []
    console_errors = []

    with sync_playwright() as pw:
        browser = pw.chromium.launch()
        # offline=True cuts the network out from under the page entirely, so a
        # passing run is proof the target needs nothing from it.
        ctx = browser.new_context(offline=True)
        ctx.on("request", lambda r: requests.append((r.method, r.url, r.resource_type)))
        ctx.on("requestfailed", lambda r: requests.append(("FAILED", r.url, r.resource_type)))

        page = ctx.new_page()
        page.on("console", lambda m: console_errors.append(m.text) if m.type == "error" else None)
        page.on("pageerror", lambda e: console_errors.append(str(e)))
        page.goto(url, wait_until="load")
        page.wait_for_function("window.__PORTFOLIO_READY__ === true", timeout=15000)

        print("offline single-file HTML (file:// URL, context offline=True)")

        err = page.evaluate("window.__PORTFOLIO_ERROR__ || null")
        check(err is None, "page ran without throwing", err or "")

        # The point of the check: call analyse() in the page, on the fixture
        # the build inlined, through the data the build inlined.
        ending = page.evaluate(
            """() => {
                const r = window.analyse(
                    window.fixture.input,
                    window.benchmarks,
                    window.strategies,
                    window.referenceId
                );
                return r.endingValue;
            }"""
        )
        check(
            isinstance(ending, (int, float)) and abs(ending - EXPECTED_ENDING_VALUE) <= CENT,
            f"analyse().endingValue == {EXPECTED_ENDING_VALUE} to the cent",
            f"got {ending!r}",
        )

        rendered = page.evaluate("document.querySelector('.headline').textContent")
        check("53,690.25" in rendered, "page renders the ending value", repr(rendered))

        check(not console_errors, "no console or page errors", "; ".join(console_errors[:3]))

        # Zero network. The document read itself is the only permitted entry.
        offenders = [r for r in requests if r[1] != url]
        check(
            not offenders,
            "zero network requests issued by the page",
            json.dumps(offenders) if offenders else f"{len(requests)} recorded (document only)",
        )
        check(
            not [r for r in requests if r[1].split(":")[0] not in ("file", "data")],
            "no request used a network scheme",
            json.dumps([r for r in requests if r[1].split(':')[0] not in ('file', 'data')]),
        )
        for r in requests:
            print(f"          recorded request: {r[0]} {r[2]} {r[1]}")

        print("\nartifact payload (pasted into a blank offline page, no module loader)")
        ctx2 = browser.new_context(offline=True)
        req2 = []
        ctx2.on("request", lambda r: req2.append((r.method, r.url)))
        page2 = ctx2.new_page()
        errors2 = []
        page2.on("pageerror", lambda e: errors2.append(str(e)))
        page2.goto("about:blank")
        page2.evaluate(ARTIFACT.read_text(encoding="utf-8"))
        ending2 = page2.evaluate("PortfolioCore.runFixture().endingValue")
        check(
            isinstance(ending2, (int, float)) and abs(ending2 - EXPECTED_ENDING_VALUE) <= CENT,
            f"artifact payload runFixture().endingValue == {EXPECTED_ENDING_VALUE}",
            f"got {ending2!r}",
        )
        check(not errors2, "artifact payload evaluated without errors", "; ".join(errors2[:3]))
        check(not req2, "artifact payload issued zero requests", json.dumps(req2))

        browser.close()

    print(f"\n{checks - len(failures)}/{checks} checks passed")
    if failures:
        print("\nFAILURES:")
        for f in failures:
            print("  - " + f)
        return 1
    print("ACCEPTANCE: PASS")
    return 0


if __name__ == "__main__":
    sys.exit(main())
