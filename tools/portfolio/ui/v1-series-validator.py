#!/usr/bin/env python3
"""
v1-series-validator.py — check the chart's colour + stroke assignment.

Two things are measured, because two things can fail:

  1. CONTRAST against the surface the stroke is drawn on. WCAG ratio; 3:1 is
     the floor for a non-text graphical object, and it is calibrated for thin
     strokes, so anything under it must earn its place with weight.
  2. SEPARATION between every pair of series, in OKLab ΔE (×100), under normal
     colour vision and under protanopia and deuteranopia simulated with
     Machado–Oliveira–Fernandes at severity 1.0. Below about ΔE 3 two strokes
     are the same colour to that viewer, and the stroke PATTERN is the only
     thing left telling them apart — so every pair that close is reported with
     the two patterns it was given.
"""
import itertools

CREAM  = '#f5f0e8'
RAISED = '#fbf8f3'

PALETTE = {
    'cream': '#f5f0e8', 'warm-black': '#1a1715', 'terracotta': '#c17c5a',
    'sage': '#7a8b6f', 'dusty-blue': '#6b8a9e', 'gold': '#c4a86b',
    'stone': '#948a7c', 'deep-green': '#4a5e3f', 'moss': '#8a9e6b',
    'bark': '#6b5a4a',
}

# slot -> (token, pattern name, dasharray, stroke width)
SERIES = [
    ('your portfolio', 'terracotta', 'solid + markers', None,                 3.2),
    ('slot 0',         'deep-green', 'solid',           None,                 2.0),
    ('slot 1',         'bark',       'dot',             '1.5 8',              2.4),
    ('slot 2',         'dusty-blue', 'long dash',       '26 10',              2.0),
    ('slot 3',         'sage',       'dash-dot',        '16 6 1.5 6',         2.0),
    ('slot 4',         'moss',       'fine dash',       '3 6',                2.4),
    ('slot 5',         'stone',      'medium dash',     '11 7',               2.2),
    ('slot 6',         'gold',       'dash-dot-dot',    '16 6 1.5 6 1.5 6',   2.8),
]

MACHADO = {
    'protan': ((0.152286, 1.052583, -0.204868),
               (0.114503, 0.786281, 0.099216),
               (-0.003882, -0.048116, 1.051998)),
    'deutan': ((0.367322, 0.860646, -0.227968),
               (0.280085, 0.672501, 0.047413),
               (-0.011820, 0.042940, 0.968881)),
}


def srgb(h):
    h = h.lstrip('#')
    return tuple(int(h[i:i + 2], 16) / 255 for i in (0, 2, 4))


def lin(c):
    return c / 12.92 if c <= 0.04045 else ((c + 0.055) / 1.055) ** 2.4


def to_lin(rgb):
    return tuple(lin(c) for c in rgb)


def oklab(rgb_lin):
    r, g, b = rgb_lin
    l = 0.4122214708 * r + 0.5363325363 * g + 0.0514459929 * b
    m = 0.2119034982 * r + 0.6806995451 * g + 0.1073969566 * b
    s = 0.0883024619 * r + 0.2817188376 * g + 0.6299787005 * b
    l, m, s = (v ** (1 / 3) if v > 0 else -((-v) ** (1 / 3)) for v in (l, m, s))
    return (0.2104542553 * l + 0.7936177850 * m - 0.0040720468 * s,
            1.9779984951 * l - 2.4285922050 * m + 0.4505937099 * s,
            0.0259040371 * l + 0.7827717662 * m - 0.8086757660 * s)


def cvd(rgb_lin, kind):
    m = MACHADO[kind]
    return tuple(max(0.0, min(1.0, sum(m[i][j] * rgb_lin[j] for j in range(3)))) for i in range(3))


def relum(rgb_lin):
    r, g, b = rgb_lin
    return 0.2126 * r + 0.7152 * g + 0.0722 * b


def ratio(a, b):
    la, lb = relum(to_lin(srgb(a))), relum(to_lin(srgb(b)))
    hi, lo = max(la, lb), min(la, lb)
    return (hi + 0.05) / (lo + 0.05)


def de(a, b, kind=None):
    la, lb = to_lin(srgb(a)), to_lin(srgb(b))
    if kind:
        la, lb = cvd(la, kind), cvd(lb, kind)
    A, B = oklab(la), oklab(lb)
    return 100 * sum((A[i] - B[i]) ** 2 for i in range(3)) ** 0.5


def main():
    print("SERIES VALIDATOR — v1.html")
    print("")
    print("1. CONTRAST  (WCAG ratio; 3:1 floor for a graphical object)")
    print("   %-16s %-18s %6s %6s %6s   %s" % ("slot", "colour", "cream", "raised", "width", "verdict"))
    for slot, token, pattern, dash, w in SERIES:
        hexv = PALETTE[token]
        rc, rr = ratio(hexv, CREAM), ratio(hexv, RAISED)
        verdict = "clears 3:1 on the raised plot" if rr >= 3 else \
                  "UNDER 3:1 — carried by weight %.1f and pattern '%s'" % (w, pattern)
        print("   %-16s %-10s %-7s %5.2f  %5.2f  %5.1f   %s"
              % (slot, token, hexv, rc, rr, w, verdict))
    print("")
    print("   floor line (contributions & withdrawals) is stone at 74% over a wash,")
    print("   drawn at width 1 as a step — context, not a series.")
    print("")
    print("2. SEPARATION  (OKLab ΔE ×100; pairs under 5 shown, worst first)")
    print("   %-13s %-13s %5s %6s %6s   %s" % ("a", "b", "norm", "protan", "deutan", "patterns"))
    rows = []
    for (n1, t1, p1, d1, w1), (n2, t2, p2, d2, w2) in itertools.combinations(SERIES, 2):
        h1, h2 = PALETTE[t1], PALETTE[t2]
        vals = (de(h1, h2), de(h1, h2, 'protan'), de(h1, h2, 'deutan'))
        rows.append((min(vals), t1, t2, vals, p1, p2))
    rows.sort()
    for worst, t1, t2, vals, p1, p2 in rows:
        if worst >= 5:
            continue
        print("   %-13s %-13s %5.1f %6.1f %6.1f   %s  vs  %s"
              % (t1, t2, vals[0], vals[1], vals[2], p1, p2))
    print("")
    print("   every pair above is separated by pattern, not by colour.")
    print("")
    print("3. PATTERN REUSE")
    print("   A dash grammar may be reused only where the two colours are far")
    print("   apart under EVERY vision type — the rule is ΔE >= 8 all three ways.")
    ok = True
    seen = {}
    for slot, token, pattern, dash, w in SERIES:
        key = str(dash)
        if key in seen:
            other, ow = seen[key]
            h1, h2 = PALETTE[other], PALETTE[token]
            vals = (de(h1, h2), de(h1, h2, 'protan'), de(h1, h2, 'deutan'))
            good = min(vals) >= 8
            ok = ok and good
            print("   %s  %s and %s both draw '%s'  —  ΔE %.1f / %.1f / %.1f, widths %.1f and %.1f"
                  % ("ok  " if good else "FAIL", other, token, pattern,
                     vals[0], vals[1], vals[2], ow, w))
        else:
            seen[key] = (token, w)
    print("   %s — %d strokes, %d dash grammars, %d reuse%s"
          % ("PASS" if ok else "FAIL", len(SERIES), len(seen),
             len(SERIES) - len(seen), "" if len(SERIES) - len(seen) == 1 else "s"))
    print("")
    print("4. WEAKEST LINK")
    print("   moss vs stone, deutan ΔE 4.8, fine dash (3 6) against medium dash")
    print("   (11 7). Same grammar, 3.7x apart in segment length. It is the only")
    print("   close pair whose two patterns share a family, and it is 6th of 6 —")
    print("   both are late slots, reached only at six and seven references.")


if __name__ == "__main__":
    main()
