#!/usr/bin/env python3
"""Emit benchmarks.json's annual block augmented with the issuer-sourced annual
rows in sources/issuer-annual.json, so that verify.mjs can gate series that the
shipped file has no annual row for (GLOBAL_EQUITY).

The shipped benchmarks.json is NOT modified. This writes a scratch file used
only as the `--annual` argument to verify.mjs.
"""
import json, os
HERE = os.path.dirname(os.path.abspath(__file__))
b = json.load(open(os.path.join(HERE, "..", "core", "src", "data", "benchmarks.json")))
extra = json.load(open(os.path.join(HERE, "sources", "issuer-annual.json")))["annual"]
for s, rows in extra.items():
    b["annual"].setdefault(s, {}).update(rows)
b["meta"]["coverage"]["annual"] += " + GLOBAL_EQUITY 2009-2021 from issuer filings (gate only, not shipped)"
out = os.path.join(HERE, "candidate", "annual-gate.json")
os.makedirs(os.path.dirname(out), exist_ok=True)
json.dump(b, open(out, "w"), indent=1)
print("wrote", out)
