#!/usr/bin/env python3
"""Build the pre-2021-10 monthly backfill candidate.

Sources (all BUILD-TIME; nothing here runs at runtime):
  primary   Yahoo Finance daily ADJUSTED CLOSE -> month-end -> monthly return
  second    totalrealreturns.com real growth-of-$10k x its own CPI-U -> nominal

Instruments deliberately switch to the Vanguard MUTUAL FUND share classes for
the backfill, because those are the exact instruments the 1996-2026 annual
series was built from. Same basis on both sides of the reconciliation.

  US_500        VFINX
  US_TOTAL      VTSMX
  INTL_TOTAL    VGTSX
  BOND_TOTAL    VBMFX
  GLOBAL_EQUITY VT (no mutual fund class existed; ETF only, from 2008-06-24)

Nothing is written that has not passed the compounding gate in verify.mjs.
"""
import bisect, datetime, json, os, sys

HERE = os.path.dirname(os.path.abspath(__file__))
RAW = os.path.join(HERE, "raw")
OUT = os.path.join(HERE, "candidate")

# series -> (ticker, first month to keep, last month to keep)
PLAN = {
    "US_500":        ("VFINX", "1996-01", "2021-09"),
    "US_TOTAL":      ("VTSMX", "1996-01", "2021-09"),
    "BOND_TOTAL":    ("VBMFX", "1996-01", "2021-09"),
    # 2003 fails the gate by +169bp and 2002 by +42bp in BOTH sources; the
    # issuer bar chart (485BPOS 2004-02-18) confirms the ANNUAL figures, so it
    # is the monthly data that is wrong. Stop the backfill at 2004-01.
    "INTL_TOTAL":    ("VGTSX", "2004-01", "2021-09"),
    # VT inception 2008-06-24. 2008 has no full calendar year to gate against, and
    # 2009 misses the issuer NAV figure by -98bp (a young, thinly traded ETF:
    # market price vs NAV). Both dropped; the gate starts clean at 2010.
    "GLOBAL_EQUITY": ("VT",    "2010-01", "2021-09"),
}


def yahoo_monthly(tk):
    d = json.load(open(os.path.join(RAW, f"yahoo_{tk}.json")))["adjclose_month_end"]
    ks = sorted(d)
    return {ks[i]: (d[ks[i]] / d[ks[i - 1]] - 1) * 100 for i in range(1, len(ks))}


def _cpi():
    c = json.load(open(os.path.join(RAW, "trr_CPI.json")))
    ds = sorted(c)
    return ([datetime.date.fromisoformat(d).toordinal() for d in ds], [c[d] for d in ds])


def trr_monthly(tk):
    """totalrealreturns.com publishes REAL levels only. Multiply back by its own
    CPI-U (linearly interpolated to the observation date, which is how the site
    deflates) to recover nominal. Skipping this step produces a uniform
    -1.5 to -4pp/yr residual across every series - the same signature as a
    price-only feed, and the reason this step is spelled out."""
    cx, cy = _cpi()
    def cpi_at(dstr):
        x = datetime.date.fromisoformat(dstr).toordinal()
        i = bisect.bisect_left(cx, x)
        if i == 0: return cy[0]
        if i >= len(cx): return cy[-1]
        if cx[i] == x: return cy[i]
        return cy[i-1] + (cy[i]-cy[i-1]) * (x-cx[i-1]) / (cx[i]-cx[i-1])
    t = json.load(open(os.path.join(RAW, f"trr_{tk}.json")))
    per = {}
    for d, v in sorted(t.items()):
        per[d[:7]] = v * cpi_at(d)
    ks = sorted(per)
    return {ks[i]: (per[ks[i]] / per[ks[i-1]] - 1) * 100 for i in range(1, len(ks))}


def clip(mo, lo, hi):
    return {m: round(v, 2) for m, v in sorted(mo.items()) if lo <= m <= hi}


if __name__ == "__main__":
    os.makedirs(OUT, exist_ok=True)
    ya, tr = {}, {}
    for s, (tk, lo, hi) in PLAN.items():
        ya[s] = clip(yahoo_monthly(tk), lo, hi)
        try:
            tr[s] = clip(trr_monthly(tk), lo, hi)
        except FileNotFoundError:
            pass
        print(f"{s:<14} {tk:<6} {lo}..{hi}  {len(ya[s])} months"
              f"  second-source: {len(tr.get(s, {}))} months")
    json.dump({"monthly": ya}, open(os.path.join(OUT, "candidate_yahoo.json"), "w"),
              indent=1, sort_keys=True)
    json.dump({"monthly": tr}, open(os.path.join(OUT, "candidate_trr.json"), "w"),
              indent=1, sort_keys=True)
    print("wrote", OUT)
