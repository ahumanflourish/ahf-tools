# Monthly backfill, 1996-01 → 2021-09

How the pre-2021-10 monthly rows in `benchmarks.json` were sourced and proved.
`verify.mjs` and everything under `src/`, `test/`, `docs/` belong to the
verification harness and are not part of this; the files below are.

## Reproduce

```bash
python3 fetch_yahoo.py VFINX VTSMX VGTSX VBMFX VT   # primary   -> raw/yahoo_*.json
python3 fetch_trr.py   VFINX VTSMX VGTSX VBMFX VT   # second    -> raw/trr_*.json
python3 build_backfill.py                           # -> candidate/candidate_*.json
python3 make_annual_gate.py                         # annual ground truth + issuer rows

node verify.mjs check candidate/candidate_yahoo.json --annual candidate/annual-gate.json
node verify.mjs diff  candidate/candidate_yahoo.json candidate/candidate_trr.json

python3 merge_backfill.py                           # refuses to move any shipped value
node verify.mjs check ../core/src/data/benchmarks.json
python3 composite_drift.py
```

`raw/` is committed on purpose. It is the evidence, and it makes every claim
here re-checkable with no network.

## Instruments

The backfill uses the Vanguard **mutual fund** share classes, not the ETFs the
2021-10 onward window uses. The ETFs mostly did not exist this far back, and
the mutual fund classes are the exact instruments the 1996-2026 annual series
was built from — so both sides of the reconciliation share a basis. That shows
up in the numbers: the +12bp/yr mean residual the harness measured on the ETF
overlap (expense-ratio gap) collapses to about +2bp on the backfill.

| series | window added | instrument |
|---|---|---|
| US_500 | 1996-01 → 2021-09 | VFINX |
| US_TOTAL | 1996-01 → 2021-09 | VTSMX |
| BOND_TOTAL | 1996-01 → 2021-09 | VBMFX |
| INTL_TOTAL | 2004-01 → 2021-09 | VGTSX |
| GLOBAL_EQUITY | 2010-01 → 2021-09 | VT |

## How total return was confirmed

Not by reading a label. Yahoo's adjusted close *claims* to reinstate
distributions; the proof is that twelve monthly returns compound onto the
annual figure — which came from Vanguard's SEC filings — to within a few basis
points, every year, for twenty-five years, with a mean residual of about zero.
A price-only feed lands 150-400bp low **every** year. Nothing here does.

Two independent confirmations beyond that:

- **Ken French Data Library** value-weighted US market total return agrees with
  the VTSMX monthly series to a mean of -0.02pp/month over 309 months. A
  price-only VTSMX would sit ~0.15pp/month below it.
- **SEC EDGAR.** Vanguard's 485BPOS filed 2004-02-18 prints VGTSX's
  calendar-year bar chart for 1997-2003; it matches this file's annual row
  digit for digit. The VT rows in `sources/issuer-annual.json` come from the
  XBRL risk/return instances of two separate 485BPOS filings, which agree with
  each other on their overlapping years.

## The trap this nearly walked into

totalrealreturns.com publishes **real** (inflation-adjusted) levels only. Taken
at face value it produced a uniform -1.5 to -4pp/yr residual on all four
series — the exact signature the SPEC warns about for price-only data. It was
not price-only; it was CPI. Multiplying back by that site's own CPI-U series
recovers nominal and the residual vanishes. Same lesson either way: a residual
that is systematically negative means the basis is wrong, and the basis is not
always the one you were looking for.
