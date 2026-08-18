#!/usr/bin/env python3
"""GLOBAL_EQUITY vs its parts, with the market weight allowed to MOVE.

The evidence behind the rolling fit now in src/composite.mjs. It refits the
weight YEAR BY YEAR, which is the crudest way to let the weight move: if
GLOBAL_EQUITY is what it claims to be, the yearly residuals collapse and the
fitted weight drifts smoothly, and if it were corrupt no per-year weight would
rescue it. Pooled: rms 25.4bp, worst annual disagreement 162bp. Per year: rms
16.7bp, worst 40bp, weight monotone 37.1% -> 62.8%. That is a real market
weight, not a data defect.

The shipped check does NOT use a per-year refit. It uses a rolling 18-month
window, because the per-year compounded disagreement is the error-level test
and fitting a weight on the same twelve months you then score is circular —
see the header of src/composite.mjs for the measurement. This script stays as
the diagnostic that made the case.
"""
import json, os, sys

HERE = os.path.dirname(os.path.abspath(__file__))
BENCH = os.path.normpath(os.path.join(HERE, "..", "core", "src", "data", "benchmarks.json"))


def fit_weight(rows):
    num = den = 0.0
    for t, a, b in rows:
        num += (a - b) * (t - b)
        den += (a - b) ** 2
    return num / den


def main(path=BENCH):
    m = json.load(open(path))["monthly"]
    g, u, i = m["GLOBAL_EQUITY"], m["US_TOTAL"], m["INTL_TOTAL"]
    months = sorted(set(g) & set(u) & set(i))
    pooled = fit_weight([(g[k], u[k], i[k]) for k in months])
    print(f"pooled weight over {len(months)} months: US {pooled*100:.1f}%")
    print(f"\n{'year':<6}{'n':>3}{'fitted US':>11}{'rms bp':>9}{'max bp':>9}{'annual bp':>11}")
    allres = []
    for y in sorted({k[:4] for k in months}):
        ks = [k for k in months if k.startswith(y)]
        rows = [(g[k], u[k], i[k]) for k in ks]
        w = fit_weight(rows)
        res = [(t - (w * a + (1 - w) * b)) * 100 for t, a, b in rows]
        allres += res
        cg = cp = 1.0
        for k in ks:
            cg *= 1 + g[k] / 100
            cp *= 1 + (w * u[k] + (1 - w) * i[k]) / 100
        print(f"{y:<6}{len(ks):>3}{w*100:>10.1f}%{(sum(r*r for r in res)/len(res))**0.5:>9.1f}"
              f"{max(map(abs, res)):>9.1f}{(cg-cp)*10000:>11.1f}")
    n = len(allres)
    print(f"\nper-year refit: rms {(sum(r*r for r in allres)/n)**0.5:.1f}bp over {n} months")


if __name__ == "__main__":
    main(sys.argv[1] if len(sys.argv) > 1 else BENCH)
