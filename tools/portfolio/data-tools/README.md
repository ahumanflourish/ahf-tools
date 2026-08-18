# benchmark verification harness

Offline checks on `benchmarks.json` and on any candidate monthly series
proposed for it. Zero dependencies, zero network calls, plain Node ESM.

It exists because of one line in `SPEC.md`:

> during the original build, four separate data-sourcing passes hit blocked
> sites, stale pages, and several sources silently serving *price-only* returns
> that understate by 1.5–4pp/yr. That class of error is invisible and corrupts
> everything downstream.

The monthly series covers 2021-10 → 2026-07 and needs extending back thirty
years. This tool does not source that data. It makes the sourcing *checkable*.

## The idea

`benchmarks.json` already carries **thirty years of annual total return**
(1996–2026) for the four core series, and only a recent window of monthly data.
So every year of a backwards monthly extension lands on top of an existing
ground truth: twelve monthly returns must compound to that year's annual
figure. No network, no second source, no trust required.

```
1996 ─────────────────────────────────────────────── 2026   annual (ground truth)
                                        2021-10 ──── 2026-07  monthly (today)
     ↑ everything sourced here is checkable against the row above
```

## Use

```bash
# full report — structure, compounding, price-only, composites. Exit 1 on FAIL.
node verify.mjs check ../core/src/data/benchmarks.json

# where the tolerances come from, measured on the real overlap
node verify.mjs noise-floor ../core/src/data/benchmarks.json

# break the good data on purpose and watch the checker catch it
node verify.mjs demo ../core/src/data/benchmarks.json

# a newly sourced monthly-only candidate, checked against the shipped annual data
node verify.mjs check candidate-1996-2021.json --annual ../core/src/data/benchmarks.json

# SPEC's mandatory second-source cross-check, mechanised
node verify.mjs diff source-a.json source-b.json --series US_500

node --test test/
```

Exit codes: `0` go, `1` no-go (or a WARN under `--strict`), `2` the tool could
not run. Add `--json` for machine output, `--no-color` for logs.

Candidate files may be a full `benchmarks.json`, a partial
`{ "monthly": {...} }`, or a bare `{ "US_500": { "1996-01": 3.4, ... } }` map.

## What it checks

**1. Compounding reconciliation** — twelve monthly returns against the
published annual figure, per series per year, reported in basis points.
Partial years at either end of the monthly window are marked SKIP rather than
failed; an *interior* gap fails, because that is a defect rather than a short
window. The final annual year is compared over exactly the months
`meta.coverage.annual`'s YTD marker says it covers. Tolerances are derived from
the data, not guessed — see [docs/NOISE-FLOOR.md](docs/NOISE-FLOOR.md).

**2. Price-only detection** — a price-return series sits below a total-return
series by the dividend yield: persistently, one-directionally, at 1.5–4pp/yr.
The detector requires both sign consistency and a magnitude in that band before
it fires, so a single bad year cannot trigger it and symmetric sourcing noise
of the same yearly size does not either. It gets its own loud verdict and names
the offending series in the summary.

**3. Structural integrity** — bad keys, interior gaps, duplicate months,
non-chronological order, values outside plausible per-series bands, nulls with
nothing in `meta.notes` explaining them, `meta.coverage` claims that do not
match the actual data, data before `meta.inception`, and strategies pointing at
series that do not exist.

Duplicate keys are found by scanning the **raw JSON text**, not the parsed
object: `JSON.parse` keeps the last value for a repeated key and drops the
other with no error anywhere. That failure is silent by construction and is
exactly the kind of thing an append script does.

**4. Cross-series composites** — `GLOBAL_EQUITY` fitted against
`US_TOTAL + INTL_TOTAL`, `TARGET_2060` against `GLOBAL_EQUITY + BOND_TOTAL`.
Reports the implied weight per year and flags a composite that disagrees with
its parts. This is the *only* internal ground truth available for
`GLOBAL_EQUITY` and `TARGET_2060`, which have no annual series at all — and it
is the check that will govern the constructed pre-2008 `GLOBAL_EQUITY` series
SPEC requires.

**5. Two-source diff** — every month where two candidate files disagree, with
magnitudes, plus a compounded per-year view. If the disagreements point
consistently one way it says so and computes the implied annual basis
difference, which is how a price-only second source announces itself.

## Offline by construction

There are no network calls in this tool and there is a test asserting there
never will be. Given the sourcing history that produced this project, anything
that can silently re-fetch is a liability; the harness reads local files and
does arithmetic.

## Layout

```
verify.mjs            CLI: check | noise-floor | demo | diff
src/load.mjs          file loading, key parsing, raw-text duplicate-key scanner
src/reconcile.mjs     compounding reconciliation, price-only detector, noise floor
src/structure.mjs     structural integrity
src/composite.mjs     cross-series composite fitting
src/diff.mjs          two-source diff
src/report.mjs        tables and verdicts
src/degrade.mjs       deliberate corruptions, used by both the tests and `demo`
test/verify.test.mjs  node:test suite
docs/NOISE-FLOOR.md   how the tolerances were derived
```
