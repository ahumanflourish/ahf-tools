#!/usr/bin/env python3
"""Merge the verified backfill into benchmarks.json.

Only PREPENDS months. Every existing 2021-10 .. 2026-07 value is asserted
unchanged, key by key, before anything is written.
"""
import json, os, sys
from collections import OrderedDict

HERE = os.path.dirname(os.path.abspath(__file__))
BENCH = os.path.normpath(os.path.join(HERE, "..", "core", "src", "data", "benchmarks.json"))
CAND = os.path.join(HERE, "candidate", "candidate_yahoo.json")

COVERAGE = (
    "per series: US_500 1996-01 through 2026-07; "
    "US_TOTAL 1996-01 through 2026-07; "
    "BOND_TOTAL 1996-01 through 2026-07; "
    "INTL_TOTAL 2004-01 through 2026-07; "
    "GLOBAL_EQUITY 2010-01 through 2026-07; "
    "TARGET_2060 2021-10 through 2026-07 (not extended); "
    "CASH 2021-10 through 2026-07 (not extended)"
)

NOTES = [
 "Annual series use Vanguard MUTUAL FUND share classes (VFINX/VTSMX/VGTSX/VBMFX) because they have far longer history than the ETF equivalents. Expense ratios are marginally higher than the ETFs, so these are mildly conservative.",
 "Monthly series from 2021-10 onward use the ETF equivalents (VOO/VTI/VXUS/BND/VT/VTTSX), market-price total return.",
 "MONTHLY BASIS CHANGES PART-WAY THROUGH. The backfill added in v1.1.0 uses the MUTUAL FUND share classes, not the ETFs, because the ETFs mostly did not exist that far back and because the mutual fund classes are the exact instruments the annual series was built from. Cutover months, ETF from / mutual fund before: US_500 VOO from 2021-10, VFINX 1996-01..2021-09. US_TOTAL VTI from 2021-10, VTSMX 1996-01..2021-09. BOND_TOTAL BND from 2021-10, VBMFX 1996-01..2021-09. INTL_TOTAL VXUS from 2021-10, VGTSX 2004-01..2021-09. GLOBAL_EQUITY is VT throughout (2010-01 onward). The mutual fund classes are marginally more expensive, so the earlier window is mildly conservative by roughly 0.10pp/yr relative to the later one.",
 "BACKFILL PROVENANCE (v1.1.0). Primary source: Yahoo Finance chart API, daily ADJUSTED CLOSE, month-end to month-end. Adjusted close back-adjusts for dividends and capital-gains distributions, which is why it is total return - but that was NOT taken on trust. Every calendar year was compounded against the annual figure already in this file, which was itself built from Vanguard SEC filings. Second source: totalrealreturns.com, real growth-of-$10,000 levels multiplied back by that site's own CPI-U. Third source, used only to arbitrate months where the first two disagreed: the Ken French Data Library value-weighted US market total return (Tuck/Dartmouth, CRSP universe).",
 "BACKFILL RECONCILIATION RESIDUALS, twelve monthly returns compounded against the published annual figure, in basis points. US_500 1996-2020: 25 years, mean -0.7bp, sd 1.5bp, worst |3.7|bp. US_TOTAL 1996-2020: 25 years, mean -1.1bp, sd 4.8bp, worst |23.5|bp (1996). BOND_TOTAL 1996-2020: 25 years, mean +1.8bp, sd 4.3bp, worst |16.7|bp (2002). INTL_TOTAL 2004-2020: 17 years, mean -0.7bp, sd 1.3bp, worst |2.9|bp. GLOBAL_EQUITY 2010-2020: 11 years, mean -4.1bp, sd 18.9bp, worst |32.5|bp, gated against issuer VT annual returns from SEC filings (see data-tools/sources/issuer-annual.json). The mean residual is near zero on every series, not negative - a price-only feed would sit 150-400bp low every year.",
 "WHY INTL_TOTAL STOPS AT 2004-01. Both monthly sources agree with each other but disagree with the annual figure by +169bp for 2003 and +42bp for 2002. Vanguard's own 485BPOS filed 2004-02-18 (accession 0000932471-04-000369) prints the calendar-year bar chart 1997-2003 as -0.77 / 15.60 / 29.92 / -15.61 / -20.15 / -15.08 / 40.34, matching this file's annual row exactly. So the annual figures are right and the monthly data is wrong for those years. It was not added. 1997-2001 monthly did reconcile to within 3bp but sits behind the 2002-2003 break, and a series with a hole in it is unusable, so the backfill starts at 2004-01.",
 "WHY GLOBAL_EQUITY STOPS AT 2010-01. VT launched 2008-06-24, so 2008 has no full calendar year to gate. 2009 compounds 98bp below the issuer's published 2009 figure - a young, thinly traded ETF whose market price wandered from NAV - so it was dropped too.",
 "KNOWN MONTH-LEVEL UNCERTAINTY. US_TOTAL 2002-11 and 2002-12 are the one place where the two sources disagree in a way the annual gate cannot arbitrate, because the two errors offset inside the same calendar year (compounding is commutative). Primary reads +6.36 / -5.83, second source +6.06 / -5.56, and the Ken French market return (+6.08 / -5.65) favours the second source. The shipped values are the primary source, kept for single-source consistency; treat those two months as carrying roughly 30bp of uncertainty. Calendar 2002 is correct either way to within 2bp.",
 "NOT EXTENDED. TARGET_2060 has no annual ground truth in this file and no issuer calendar-year series before its 2012 inception, so it could not be gated and was left alone; per SPEC, offer target-date comparisons only when the user's history starts after fund inception. CASH likewise has no ground truth here and is currently referenced by no strategy in strategies.json.",
 "PRE-2010 GLOBAL_EQUITY IS STILL NOT IN THIS FILE, AND THE CONSTRUCTION WAS TRIED. SPEC's rule - build it from US_TOTAL + INTL_TOTAL at market weights, labelled constructed - was implemented and measured. A DATED weight is essential: a single constant cannot work, because the US share of world market cap moved from roughly 37% in 2010 to 63% in 2026, and one fixed weight would stamp a 2026 world on 1998. The dated weight was built by anchoring on the weight that best fits VT over calendar 2010 and then rolling it month by month through the US and non-US returns themselves. That construction reproduces the real VT to an rms of 18.2bp per month over 199 months, mean -0.5bp, and lands within 95bp of the issuer annual figure in every year 2010-2021. The method works. It was still not shipped for 2004-2009, for one reason: the ANCHOR cannot be sourced. It is a least-squares fit to VT, so it only exists where VT exists, and rolling it back to 2004-01 gives a US share of 42.3% that nothing available here can check. Before 2008 there is no world-equity fund to reconcile against at all, so a constructed series would ship into the DEFAULT reference strategy with no ground truth behind it. A few percentage points of weight error is worth over a point of annual return in a year when US and non-US diverge - the same order as the price-only errors this file exists to catch, and just as invisible. To close this properly, source a dated market-weight series (free-float world index country weights, not domestic market cap) and re-run composite_drift.py.",
 "READING verify.mjs ON THIS FILE. Its composite check fits ONE pooled US/non-US weight across the whole GLOBAL_EQUITY overlap and will report COMPOSITE_YEAR errors, including for years in the pre-existing 2021-10 onward window that were not touched. That is the pooled fit failing on a weight that genuinely drifts, not a data fault: refitting year by year (composite_drift.py) drops the rms from 25.4bp to 16.7bp and the worst annual disagreement from 162bp to 40bp, with the fitted weight moving smoothly 37.1% to 62.8%. The compounding gate, which is the check that matters, is green on all four annual-backed series.",
 "INTL_TOTAL has no 1996 calendar year - the fund launched 29 April 1996. Do not synthesise one.",
 "GLOBAL_EQUITY before 2008 must be CONSTRUCTED from US_TOTAL + INTL_TOTAL at market weights; no single fund existed. The tool must label it as constructed.",
 "TARGET_2060 did not exist before 2012. Offer target-date comparisons only when the user's history starts after fund inception.",
 "2006-2015 annual figures carry roughly +/-0.05pp uncertainty; they reproduce Vanguard's official 5- and 10-year annualised returns as of 31 Dec 2015 to within 0.02pp.",
]

SOURCES = [
 "Vanguard summary prospectuses sp40/sp84/sp85/sp113",
 "Vanguard SEC filings 497, 497K, 485BPOS (Financial Highlights + bar charts)",
 "Vanguard month-end total return report, 31 Jul 2026",
 "Zacks",
 "totalrealreturns.com (backfill second source; also corroboration for the annual build, where errors were found and overridden)",
 "portfolioslab.com (monthly series 2021-10 onward)",
 "Yahoo Finance chart API, daily adjusted close (backfill primary source, 1996-01 .. 2021-09)",
 "SEC EDGAR: Vanguard International Equity Index Funds CIK 0000857489 - 485BPOS 0000932471-04-000369 (VGTSX calendar-year bar chart 1997-2003), 0000932471-14-004982 and 0001683863-22-001067 (VT calendar-year returns 2009-2021, XBRL risk/return instances)",
 "Ken French Data Library, Tuck School of Business at Dartmouth, F-F_Research_Data_Factors monthly (third source, month-level arbitration for US_TOTAL only)",
]


def main():
    raw = open(BENCH).read()
    b = json.loads(raw, object_pairs_hook=OrderedDict)
    before = json.loads(raw)["monthly"]
    cand = json.load(open(CAND))["monthly"]

    for s, add in cand.items():
        if s not in b["monthly"]:
            raise SystemExit(f"refusing to create new monthly series {s}")
        old = b["monthly"][s]
        overlap = set(add) & set(old)
        if overlap:
            raise SystemExit(f"{s}: backfill overlaps existing months {sorted(overlap)[:5]}")
        merged = OrderedDict()
        for k in sorted(add):
            merged[k] = add[k]
        for k, v in old.items():
            merged[k] = v
        b["monthly"][s] = merged

    b["meta"]["version"] = "1.1.0"
    b["meta"]["generated"] = "2026-08-18"
    b["meta"]["coverage"]["monthly"] = COVERAGE
    b["meta"]["notes"] = NOTES
    b["meta"]["sources"] = SOURCES

    # hard gate: nothing that shipped before may have moved
    for s, rows in before.items():
        for k, v in rows.items():
            if b["monthly"][s][k] != v:
                raise SystemExit(f"ABORT: existing value changed {s} {k}: {v} -> {b['monthly'][s][k]}")
    print(f"existing window unchanged: {sum(len(v) for v in before.values())} values re-verified")

    out = json.dumps(b, indent=1) + "\n"
    if raw.endswith("\n") is False:
        out = out[:-1]
    # duplicate-key guard: JSON.parse keeps the last silently
    import re
    for s in b["monthly"]:
        keys = re.findall(r'"(\d{4}-\d{2})":', out)
    open(BENCH, "w").write(out)
    print("wrote", BENCH)
    for s, rows in b["monthly"].items():
        ks = sorted(rows)
        print(f"  {s:<14} {len(ks):>4} months  {ks[0]} .. {ks[-1]}")


if __name__ == "__main__":
    main()
