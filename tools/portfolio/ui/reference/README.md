# frozen reference screens

Three standalone screens, each built and reviewed on its own before anything
was assembled: the review table, the portfolio-value chart, and the capture
bar. Each one was verified standalone, and its audit and validator passed at
the time it was frozen. This directory is where they stopped.

**These are not to be edited.** They are a fixed record of the behaviour each
screen was signed off on. The live tool is `../app.html`, which assembles all
three into one page; it will keep moving, and these will not. They *will*
diverge, and that is the point — the assembled app can be diffed against the
behaviour defined here, and the audits below stay runnable against the
originals so that a difference in result can be attributed to the assembly
rather than argued about.

## What is what

```
table.html                 the review table — paste, parse, correct, commit
v1.html                    the portfolio-value chart — your line against references
v2.html                    the capture bar — what you kept, what you gave up

table-layout-audit.py      zone A never moves; zone B grows only below a declared floor
v1-layout-audit.py         no control and no plot area moves in any transition
v2-layout-audit.py         same, plus: the two reserved-height blocks stay reserved

v1-series-validator.py     stroke contrast and pairwise separation, normal and CVD
v2-series-validator.py     fill contrast, label contrast, separation of fills that share a bar
v1-scale-check.js          the log axis always yields usable ticks, over every range
```

The three layout audits drive a real browser through a scripted sequence of
state changes and measure document-space bounding boxes after each one. The two
series validators are pure arithmetic on the palette and take no input. The
scale check lifts the tick-ladder functions out of `v1.html` at run time rather
than keeping a second copy, so it fails loudly if the markers in that file ever
move.

## Running them

All six take their target from a sibling file in this directory by default, so
they run from here with no arguments:

```bash
python3 table-layout-audit.py
python3 v1-layout-audit.py
python3 v2-layout-audit.py
python3 v1-series-validator.py
python3 v2-series-validator.py
node v1-scale-check.js
```

The three layout audits need Playwright and take about a minute each; they run
every step at both 1280px and 640px. Each accepts `--file` and `--width`, and
`v1-scale-check.js` accepts `--file`, if you want to point one at
`../app.html` instead. Exit code 0 is a pass, 1 a fail.

## Screenshots

The `v1-*.png` and `v2-*.png` files here (118 and 40 of them) are the review
shots for the chart and the capture bar, by revision and viewport width.
`shots/` holds the fourteen `table-*.png` files for the review table. They were
moved here with the screens they document: the assembled app writes its own
`app-*` shots into `../`, and leaving these alongside would have made it
impossible to tell at a glance which picture was of which thing.
