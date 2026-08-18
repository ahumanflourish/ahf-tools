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

## Re-measured after the v1.1.0 backfill — and why the thresholds did NOT move

The paragraph above says to re-run `noise-floor` on the extended file. Done:

```
  US_TOTAL     n=31  median   0.2  mean  0.9  sd  6.9  max|23.5|
  INTL_TOTAL   n=23  median  -0.8  mean  1.8  sd 11.5  max|43.9|
  BOND_TOTAL   n=31  median   2.4  mean  3.6  sd  6.2  max|24.2|
  US_500       n=31  median   0.1  mean  2.0  sd  6.1  max|21.6|

  POOLED       n=116  median 0.3  mean 2.1  sd 7.6  p95|21.2|  max|43.9|

  suggested warn threshold: 40bp        shipped: 60bp
  suggested fail threshold: 80bp        shipped: 120bp
```

The sample went from 20 series-years to 116 and the pooled mean fell from
+12bp to +2bp, so the tool's own `|mean| + 4sd` rule now suggests 40/80. **The
shipped defaults stay at 60/120.** Three reasons, in order of weight.

**1. The pooled sample is now two populations, and the suggestion averages
across them.** Term (2) above — the ETF-vs-mutual-fund share-class gap — is
the reason the old mean was +12bp. The backfill does not have it:
`meta.notes` records that the pre-2021-10 months use the *same* mutual-fund
share classes the annual series was built from, so its residuals are centred
on zero by construction. The two eras measured separately:

| era | basis of monthly vs annual | n | mean |
|---|---|---|---|
| 1996–2020 | mutual fund vs mutual fund — same instrument | 92 | −0.1bp |
| 2021 | cutover year, nine months mutual fund + three ETF | 4 | +3.1bp |
| 2022–2026 | ETF vs mutual fund — ~0.11pp/yr expense gap | 20 | +12.1bp |

The pooled mean of +2bp is not the floor getting tighter. It is 92 zero-mean
observations diluting 20 offset ones — and the cutover year sits neatly
between them, at about a quarter of the offset, which is exactly the three
ETF months out of twelve. `|mean| + 4sd` on a sample like this describes
neither half.

**2. A 40bp warn threshold would immediately flag data nobody touched.**
`INTL_TOTAL` 2023 has a residual of 43.9bp — the largest in the file,
documented, explained by term (3), and present before any of this work. Warn
at 40 and the shipped file reports `WARN` on it from day one. A threshold whose
first act is to flag its own baseline is the same defect this harness has
already had once, in the composite check.

**3. The tightening argument is still real, but it is per-era, not global.**
Over 1996–2020 the floor genuinely is much tighter: `US_500` puts 25 of its 31
years inside ±2bp. A 60bp warn is very loose there and would miss a small
systematic error confined to the backfill. The right response is a per-era or
per-series tolerance, not a global 40 — and that is more machinery than is
justified before there is a second backfill to calibrate it against.

**Practical guidance.** Leave the defaults alone for `check` on the full file.
When verifying a backfill *fragment* in isolation, where the basis is uniform
and term (2) is absent, run it at the tighter numbers:

```
node verify.mjs check candidate.json --annual ../core/src/data/benchmarks.json \
  --warn-bp 40 --fail-bp 80
```

The composite check's own thresholds are a separate matter and *did* move; see
the header of `src/composite.mjs`. Its per-year floor was only ever inheriting
120bp from this table for want of a measurement of its own, and the rolling
fit finally provides one: 41bp clean against 134bp for a price-only series.

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
