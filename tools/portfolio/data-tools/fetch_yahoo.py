#!/usr/bin/env python3
"""Build-time fetcher: daily ADJUSTED CLOSE from Yahoo Finance chart API.

Adjusted close back-adjusts for dividends and capital-gains distributions, so
month-end-to-month-end adjclose ratios are TOTAL returns. That claim is NOT
taken on trust: reconcile.py compounds the result against the independently
sourced annual total-return series and the residual must sit inside the
established noise floor. A price-only series shows up as a 150-400bp/yr
negative residual.

This is a BUILD-TIME tool. Its output is committed as static JSON; nothing
here runs at runtime.
"""
import json, sys, time, urllib.request, os

UA = ("Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 "
      "(KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36")
RAW = os.path.join(os.path.dirname(os.path.abspath(__file__)), "raw")


def fetch(ticker, p1, p2, host="query1"):
    url = (f"https://{host}.finance.yahoo.com/v8/finance/chart/{ticker}"
           f"?interval=1d&period1={p1}&period2={p2}&events=div%7Csplit")
    req = urllib.request.Request(url, headers={"User-Agent": UA, "Accept": "application/json"})
    with urllib.request.urlopen(req, timeout=60) as r:
        return json.load(r)


def month_end_adjclose(payload):
    """-> {'YYYY-MM': adjclose_of_last_trading_day}"""
    res = payload["chart"]["result"][0]
    # Yahoo daily timestamps are the exchange-local market OPEN. Bucketing them
    # by UTC date pushes US bars near a month boundary into the wrong month, so
    # shift by the exchange's own gmtoffset before taking the calendar month.
    off = res["meta"].get("gmtoffset", 0)
    ts = res["timestamp"]
    adj = res["indicators"]["adjclose"][0]["adjclose"]
    close = res["indicators"]["quote"][0]["close"]
    out, out_close = {}, {}
    for t, a, c in zip(ts, adj, close):
        if a is None:
            continue
        ym = time.strftime("%Y-%m", time.gmtime(t + off))
        out[ym] = a
        out_close[ym] = c
    return out, out_close


if __name__ == "__main__":
    tickers = sys.argv[1:] or ["VTSMX", "VFINX", "VGTSX", "VBMFX"]
    P1, P2 = 788918400, 1785283200  # 1995-01-01 .. 2026-07-31
    for tk in tickers:
        for host in ("query1", "query2"):
            try:
                pl = fetch(tk, P1, P2, host)
                break
            except Exception as e:
                print(f"  {tk} via {host}: {e}", file=sys.stderr)
                pl = None
                time.sleep(3)
        if pl is None:
            print(f"FAILED {tk}", file=sys.stderr)
            continue
        adj, clo = month_end_adjclose(pl)
        os.makedirs(RAW, exist_ok=True)
        with open(os.path.join(RAW, f"yahoo_{tk}.json"), "w") as f:
            json.dump({"ticker": tk, "adjclose_month_end": adj,
                       "close_month_end": clo}, f, indent=1, sort_keys=True)
        ks = sorted(adj)
        print(f"{tk}: {len(ks)} months  {ks[0]} .. {ks[-1]}")
        time.sleep(2)
