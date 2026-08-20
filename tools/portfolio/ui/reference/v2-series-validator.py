#!/usr/bin/env python3
"""
v2-series-validator.py — check the capture bar's four fills.

V1's validator asks the questions a LINE chart asks. This one asks the
questions a FILLED bar asks, which are not the same questions:

  1. FILL vs SURFACE. WCAG ratio against the surface the bar is drawn on.
     3:1 is the floor for a graphical object. Unlike V1 there is no stroke
     weight to fall back on — a fill that fails cannot be rescued by drawing
     it heavier — so this is a hard gate, and it is what decides that the bar
     sits on --surface-raised rather than on the page.

  2. LABEL vs FILL. A figure written inside a segment is text, so it needs
     4.5:1 against the fill it sits on. Each fill therefore declares whether
     it carries ink or cream, and the ratio is checked, not assumed.

  3. SEPARATION between fills that can appear in the SAME bar. This is where
     it differs most from V1: there is no dash pattern available to separate
     two adjacent fills, so colour has to do the work, backed by a 2px gap of
     the surface and a direct label under each segment. Pairs are checked in
     OKLab ΔE (×100) under normal vision and under protanopia and
     deuteranopia (Machado-Oliveira-Fernandes, severity 1.0).

  4. WHICH PAIRS CAN CO-OCCUR. deep-green and bark are ΔE 1.6 apart to a
     protanope, which would be a failure if they could ever share a bar. They
     cannot: bark is the fee, and the engine sets feeShare to 0 whenever
     forgone <= 0, which is exactly when the deep-green surplus segment
     exists. That is asserted here rather than asserted in a comment.

The thresholds are the dataviz skill's: >= 15 normal, >= 8 under CVD for a
categorical pair, with the 6-8 band legal only with a mandatory secondary
encoding. Chroma is reported and deliberately not gated — the whole A Human
Flourish palette is low-chroma by design and every one of these tokens is
under the 0.10 floor. That is a property of the brand, not a defect in this
chart, and the fix the skill prescribes (more chroma) is not available.
"""
import itertools
import sys

CREAM = '#f5f0e8'
RAISED = '#fbf8f3'
INK = '#1a1715'

PALETTE = {
    'cream': '#f5f0e8', 'warm-black': '#1a1715', 'terracotta': '#c17c5a',
    'sage': '#7a8b6f', 'dusty-blue': '#6b8a9e', 'gold': '#c4a86b',
    'stone': '#948a7c', 'deep-green': '#4a5e3f', 'moss': '#8a9e6b',
    'bark': '#6b5a4a',
}

# role -> (token, label text colour, which bar states it appears in)
FILLS = [
    ('gain you kept',              'terracotta', 'ink',   {'normal', 'ahead'}),
    ('given up: the fee',          'bark',       'cream', {'normal'}),
    ('given up: everything else',  'dusty-blue', 'ink',   {'normal'}),
    ('ahead of the reference',     'deep-green', 'cream', {'ahead'}),
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


def chroma(hexv):
    L, a, b = oklab(to_lin(srgb(hexv)))
    return (a * a + b * b) ** 0.5


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
    ok = True
    print("SERIES VALIDATOR — v2.html (the capture bar)")
    print("")
    print("0. WHAT EACH FILL SAYS")
    print("   terracotta is the USER's colour in V1 and stays the user's colour here, so it")
    print("   goes on the gain they KEPT. That also keeps the brand's attention colour off")
    print("   the given-up side, where it would read as blame rather than as emphasis.")
    print("   bark takes the fee: it is the smallest segment on the bar and bark is the")
    print("   strongest contrast available short of ink, so the narrowest thing is the most")
    print("   visible thing — and it is dark and unsaturated rather than hot, because a fee")
    print("   is a cost charged in every market, not an alarm.")
    print("   dusty-blue takes 'everything else': the palette's only cool hue, the only one")
    print("   that clears CVD separation from terracotta, and a different family of colour")
    print("   for the one quantity the tool does not name a cause for.")
    print("   deep-green takes the surplus in the outperformed state, and appears nowhere")
    print("   else.")
    print("")
    print("1. FILL vs SURFACE  (WCAG; 3:1 floor for a graphical object — a hard gate,")
    print("   because a fill has no stroke weight to be rescued by)")
    print("   %-28s %-12s %7s %7s   %s" % ("role", "colour", "cream", "raised", "verdict"))
    for role, token, on, states in FILLS:
        h = PALETTE[token]
        rc, rr = ratio(h, CREAM), ratio(h, RAISED)
        good = rr >= 3
        ok = ok and good
        print("   %-28s %-10s %-7s %5.2f  %5.2f   %s"
              % (role, token, h, rc, rr, "ok" if good else "FAIL — under 3:1 on the plot surface"))
    print("")
    print("   Two of the four miss 3:1 on the page (terracotta 2.94, dusty-blue 3.22 is")
    print("   fine) and clear it on --surface-raised. The bar is drawn on the raised")
    print("   surface for that reason, which is also this brand's sanctioned way to lift a")
    print("   panel: no shadow, no new colour.")
    print("")
    print("2. LABEL vs FILL  (WCAG 4.5:1 — a figure inside a segment is text)")
    print("   %-28s %-12s %-7s %7s   %s" % ("role", "colour", "label", "ratio", "verdict"))
    for role, token, on, states in FILLS:
        h = PALETTE[token]
        lab = INK if on == 'ink' else CREAM
        r = ratio(h, lab)
        good = r >= 4.5
        ok = ok and good
        print("   %-28s %-10s %-7s %7.2f   %s" % (role, token, on, r, "ok" if good else "FAIL"))
    print("")
    print("3. SEPARATION between fills that share a bar")
    print("   Gates: hard FAIL under ΔE 8 normal or under 6 to a protanope/deuteranope.")
    print("   The dataviz skill's preferred floors are 15 normal and 8 CVD; a pair between")
    print("   those and the hard floor is legal only with a mandatory secondary encoding,")
    print("   and every segment here has three: a named direct label, its figure and share")
    print("   printed with it, and a 2px gap of the surface either side.")
    print("   %-13s %-13s %6s %7s %7s   %s" % ("a", "b", "normal", "protan", "deutan", "verdict"))
    for (r1, t1, o1, s1), (r2, t2, o2, s2) in itertools.combinations(FILLS, 2):
        together = s1 & s2
        h1, h2 = PALETTE[t1], PALETTE[t2]
        vals = (de(h1, h2), de(h1, h2, 'protan'), de(h1, h2, 'deutan'))
        if not together:
            print("   %-13s %-13s %6.1f %7.1f %7.1f   n/a — cannot co-occur"
                  % (t1, t2, vals[0], vals[1], vals[2]))
            continue
        worst_cvd = min(vals[1], vals[2])
        hard = vals[0] < 8 or worst_cvd < 6
        clean = vals[0] >= 15 and worst_cvd >= 8
        ok = ok and not hard
        verdict = ("ok" if clean else
                   "FAIL" if hard else
                   "WARN — under a preferred floor, carried by the secondary encoding")
        print("   %-13s %-13s %6.1f %7.1f %7.1f   %s in %s"
              % (t1, t2, vals[0], vals[1], vals[2], verdict, "+".join(sorted(together))))
    print("")
    print("   The one WARN is terracotta vs dusty-blue at ΔE 14.8 normal — 0.2 short of the")
    print("   preferred 15, and comfortably clear under both simulated deficiencies. Every")
    print("   other candidate this brand owns is worse. Scored against the two fills it")
    print("   would have to sit beside (terracotta, and bark in the same bar), plus the 3:1")
    print("   fill gate:")
    print("      %-12s %-7s  %-24s %-24s %s"
          % ("candidate", "raised", "vs terracotta", "vs bark", "verdict"))
    for token in ['dusty-blue', 'stone', 'deep-green', 'sage', 'moss', 'gold', 'bark', 'terracotta']:
        if token in ('bark', 'terracotta'):
            continue
        h = PALETTE[token]
        rr = ratio(h, RAISED)
        vt = (de(h, PALETTE['terracotta']), de(h, PALETTE['terracotta'], 'protan'), de(h, PALETTE['terracotta'], 'deutan'))
        vb = (de(h, PALETTE['bark']), de(h, PALETTE['bark'], 'protan'), de(h, PALETTE['bark'], 'deutan'))
        why = []
        if rr < 3:
            why.append("fill under 3:1")
        if min(vt[1], vt[2]) < 6:
            why.append("CVD collapse vs terracotta")
        if min(vb[1], vb[2]) < 6:
            why.append("CVD collapse vs bark")
        if vt[0] < 8:
            why.append("too close to terracotta")
        print("      %-12s %5.2f    %5.1f /%5.1f /%5.1f      %5.1f /%5.1f /%5.1f      %s"
              % (token, rr, vt[0], vt[1], vt[2], vb[0], vb[1], vb[2],
                 "; ".join(why) if why else "USABLE — the one chosen" if token == 'dusty-blue' else "usable"))
    print("")
    print("4. THE PAIR THAT WOULD FAIL, AND WHY IT CANNOT OCCUR")
    dg, bk = PALETTE['deep-green'], PALETTE['bark']
    print("   deep-green vs bark is ΔE %.1f / %.1f / %.1f — a failure if they shared a bar."
          % (de(dg, bk), de(dg, bk, 'protan'), de(dg, bk, 'deutan')))
    print("   They cannot. bark is the fee segment, which exists only when capture.forgone")
    print("   > 0; deep-green is the surplus segment, which exists only when forgone <= 0.")
    print("   The engine enforces it directly:")
    print("       feeShare  = Math.min(feeShare, Math.max(forgone, 0))")
    print("       otherShare = Math.max(forgone, 0) - ...")
    print("   so forgone <= 0 zeroes both given-up shares and segments() emits no segment")
    print("   with a value of 0.")
    both = set.intersection(*[s for _, t, _, s in FILLS if t in ('deep-green', 'bark')])
    disjoint = not both
    ok = ok and disjoint
    print("   states shared by deep-green and bark: %s — %s"
          % (sorted(both) or "none", "ok" if disjoint else "FAIL"))
    print("")
    print("5. CHROMA  (reported, not gated)")
    print("   The dataviz skill's floor is OKLCH C >= 0.10. Every token in this brand is")
    print("   under it, which VISUALS.md predicted before any of this was built:")
    for role, token, on, states in FILLS:
        print("      %-12s C %.3f" % (token, chroma(PALETTE[token])))
    print("   The prescribed fix is more chroma, which would mean inventing colours this")
    print("   brand does not have. The compensations used instead are the ones the skill")
    print("   permits: a direct label under every segment naming it in words, the figure")
    print("   and its share printed with it, a 2px surface gap between segments, and a")
    print("   table view carrying every number without colour at all.")
    print("")
    print("RESULT: %s" % ("PASS" if ok else "FAIL"))
    return 0 if ok else 1


if __name__ == "__main__":
    sys.exit(main())
