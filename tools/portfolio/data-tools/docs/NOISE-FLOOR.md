# The noise floor, and where the tolerances come from

The compounding check asks a simple question — do twelve monthly returns
compound to the published annual return? — and the only hard part is deciding
how big a residual is allowed before it means something.

A nonzero residual is *expected*. This document works out how big.

## What the residual actually contains

Three things, in increasing order of size.

**1. Rounding.** Published monthly figures carry two decimal places, so each
month is a percent value ±0.005pp. Twelve of those compound as a random walk:
`sqrt(12) × 0.005 / sqrt(3) ≈ 0.01pp ≈ 1bp`. The annual figure is rounded the
same way, adding another ~0.3bp. Rounding alone therefore accounts for **1–2bp**,
which is far too small to explain what we see.

**2. Share-class basis.** `meta.notes` in `benchmarks.json` says it outright:
the annual series use Vanguard **mutual fund** share classes (VFINX, VTSMX,
VGTSX, VBMFX) because they have the longest history, while the monthly series
use the **ETF** equivalents (VOO, VTI, VXUS, BND) at market price. The ETFs
have lower expense ratios — roughly 0.11pp/yr for VFINX vs VOO — so the monthly
series should compound to slightly *more* than the annual figure. This is the
dominant term, and it has a predictable sign.

**3. Market-price vs NAV.** The ETF monthly series are market-price total
return; the mutual fund figures are NAV. Premiums and discounts wash out over a
year but not exactly, and they are largest where the underlying trades in a
different time zone. This is why `INTL_TOTAL` is the noisiest series in the
table below by a wide margin.

## The measurement

Run it yourself:

```
node verify.mjs noise-floor ../core/src/data/benchmarks.json
```

Residuals are computed only over years where the monthly window covers the
annual period *exactly*: the four full years 2022–2025, plus 2026, whose annual
figure is documented as YTD through 31 Jul and whose monthly data runs to
2026-07. The stub year 2021 (Oct–Dec against a full-year annual figure) is
excluded — comparing three months to a twelve-month figure is meaningless, and
treating it as a residual would poison the statistics.

That gives **20 series-years** across the four series that have both an annual
and a monthly track.

```
  US_TOTAL     n= 5  median     7.7  mean    10.7  sd    8.4  max|21.2|   7 17 21  8  0
  INTL_TOTAL   n= 5  median    -2.3  mean    12.6  sd   22.6  max|43.9|  -3 44 -2 30 -6
  BOND_TOTAL   n= 5  median    10.4  mean    11.9  sd    7.8  max|24.2|  14  5 24  5 10
  US_500       n= 5  median    11.1  mean    13.2  sd    5.5  max|21.6|   7 22 15 10 11

  POOLED       n=20  median 10.4  mean 12.1  sd 11.9  p95|29.6|  max|43.9|
  (geometric:  median  9.6  mean 10.8  sd 10.2  max|38.0|)
```

**The empirical noise floor is a mean of +12bp with a standard deviation of
12bp, and no residual anywhere in the shipped data exceeds 44bp.**

Note the sign. Fifteen of the twenty residuals are positive and the mean is
clearly above zero — that is term (2) above, the ETF expense advantage, showing
up exactly where theory says it should and at roughly the size theory predicts
(~11bp/yr). This is a good sign, not a bad one: it means the residual is
*explained*, not merely small.

## The tolerances

| threshold | value | reasoning |
|---|---|---|
| warn | **60bp** | \|mean\| + 4sd = 60bp, rounded up. Also ~1.4× the worst residual observed anywhere in the shipped file. A year above this is outside anything the current data does. |
| fail | **120bp** | 2× warn. Still comfortably below 150bp, the bottom edge of the dividend-yield band, so a price-only series fails on magnitude *and* is separately named by the price-only detector. |

Both are overridable (`--warn-bp`, `--fail-bp`). If you extend the monthly
series back 30 years using a source with a different basis than the ETF one —
a mutual-fund monthly series, say — re-run `noise-floor` on the extended file
and re-derive them. The tool prints its own suggestion from the data it sees.

**A caveat worth stating.** Twenty observations is a thin sample and every one
of them comes from a five-year window sourced in a single pass from a single
provider. It establishes that the *current* data is internally consistent. It
does not establish that a 1998 residual will behave the same way, and if the
backwards extension comes from a different provider the floor should be
re-measured over the new years rather than assumed.

## Why price-only detection uses a different number

The residual above is arithmetic: `compounded − annual`. For flagging a year
that's the intuitive number and it is what the table shows.

For price-only detection the tool uses the **geometric** residual instead:

```
geomBp = ((1 + compounded/100) / (1 + annual/100) − 1) × 10000
```

because a dividend yield is a ratio, not a subtraction. A 2pp yield costs
~250bp of arithmetic residual in a +25% year and ~165bp in a −18% year; it
costs 200bp geometrically in both. Using the arithmetic residual would make the
implied yield swing with the market and blur the band the detector is looking
for.

## The price-only signature

A price-only series understates a total-return series by the dividend yield:
**persistently, in one direction, at 1.5–4pp/yr** for broad equity indices.
Sourcing noise is symmetric and small. The detector therefore requires both:

- ≥80% of comparable years short of the annual figure, and
- a median geometric shortfall in the 100–600bp band

before it says `PRICE_ONLY`, and reports the sign-consistency p-value alongside
so you can see how much of the case rests on consistency versus magnitude. With
only five overlap years, 5/5 one-sided gives p≈0.06 — suggestive, not decisive
on its own, which is why the magnitude test carries most of the weight today.
Extend the monthly series back 30 years and the sign test alone becomes
overwhelming.

One honest wrinkle: what the detector measures is the injected yield **net of
the basis offset** in term (2). Degrading the shipped `US_500` by exactly
2.2pp/yr and re-running reports an implied 2.03pp/yr, because the ETF expense
advantage of ~0.15pp/yr is working in the opposite direction. That is the
correct answer to the question actually being asked ("how far does this series
sit below the ground truth"), and it is why `inCanonicalBand` allows a little
slack at both edges of SPEC's 1.5–4pp range.

## What the floor does not cover

The compounding check is blind to any error that cancels within a calendar
year — two months transposed, or one month too high and another too low by the
same amount. `diff` against a second source catches those; the compounding
check will not. This is the main reason SPEC's "cross-check against a second
source" rule still stands even with this harness in place.
