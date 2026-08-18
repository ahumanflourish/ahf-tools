#!/usr/bin/env python3
"""Second-source fetcher: totalrealreturns.com growth-of-$10,000 series.

The page embeds its chart columns as base64 Float32 arrays plus a delta-encoded
shared date column. We decode the first (nominal, dividends-reinvested) series
and reduce it to month-end levels.

CORROBORATION ONLY. benchmarks.json meta.notes records that errors were found in
this site during the annual build and overridden. Never primary.
"""
import base64, json, os, re, struct, sys, time, urllib.request

UA = ("Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 "
      "(KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36")
RAW = os.path.join(os.path.dirname(os.path.abspath(__file__)), "raw")


def decode_f32(b64):
    raw = base64.b64decode(b64)
    return list(struct.unpack("<%df" % (len(raw) // 4), raw))


def get(ticker):
    req = urllib.request.Request(f"https://totalrealreturns.com/s/{ticker}",
                                 headers={"User-Agent": UA})
    html = urllib.request.urlopen(req, timeout=60).read().decode("utf8", "replace")
    m = re.search(r"let sharedDatesColumnInput = \[([0-9,\s]+)\]", html)
    deltas = [int(x) for x in m.group(1).split(",")]
    days, cur = [], 0
    for i, d in enumerate(deltas):
        cur = d if i == 0 else cur + d
        days.append(cur)
    # first chart on the page is Growth of $10,000, nominal, divs reinvested
    i = html.find("Growth of $10,000")
    m2 = re.search(r'decodeFloat32Column\("([A-Za-z0-9+/=]+)"\)', html[i:])
    vals = decode_f32(m2.group(1))
    assert len(vals) == len(days), (len(vals), len(days))
    out = {}
    for d, v in zip(days, vals):
        if v != v:  # NaN
            continue
        out[time.strftime("%Y-%m-%d", time.gmtime(d * 86400))] = v
    return out


if __name__ == "__main__":
    os.makedirs(RAW, exist_ok=True)
    for tk in sys.argv[1:]:
        try:
            o = get(tk)
        except Exception as e:
            print(f"{tk}: FAILED {e}", file=sys.stderr)
            continue
        json.dump(o, open(os.path.join(RAW, f"trr_{tk}.json"), "w"), indent=1, sort_keys=True)
        ks = sorted(o)
        print(f"{tk}: {len(ks)} months {ks[0]}..{ks[-1]}")
        time.sleep(2)
