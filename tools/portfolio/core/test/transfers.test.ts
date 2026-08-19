/**
 * Internal-transfer detection.
 *
 * Two kinds of assertion here, and they are doing different jobs.
 *
 * 1. DETECTOR BEHAVIOUR — window, tolerance, same-day, clusters, purity. These
 *    pin the parameters so a change to any of them is deliberate.
 *
 * 2. ACCEPTANCE, against the engine — `synthetic.test.ts` §6 already contains
 *    the two cases and measured the impact of each. They are re-asserted here
 *    THROUGH `findMatchedFlows`, because §6's whole point is that the engine
 *    offers no detection and cannot absorb the error on its own. A same-month
 *    pair moves XIRR by 1.7bp and nothing else; a pair straddling a month
 *    boundary moves the reference ending value by $434.69 and the headline
 *    capture figure by more than 0.1pp, because `replay` nets flows per
 *    calendar month. The detector has to fire on both and say which is which.
 *
 * Nothing here modifies `fixtures.json`; the fixture rows are read only.
 */
import { describe, it, expect } from 'vitest';

import {
  findMatchedFlows,
  TRANSFER_WINDOW_DAYS,
  TRANSFER_ABS_TOLERANCE,
  TRANSFER_REL_TOLERANCE,
} from '../src/index';
import type { InputRow, PortfolioInput } from '../src/index';

import fixturesJson from '../src/data/fixtures.json' with { type: 'json' };

import { balance, contribution, referenceId, run, withdrawal } from './synthetic/shapes';

const ref = (r: ReturnType<typeof run>) => r.strategies.find((s) => s.id === referenceId)!;

const fixtureRows = (fixturesJson as unknown as { input: PortfolioInput }).input.rows;

// ═══════════════════════════════════════════════ 1. the reference fixture

describe('findMatchedFlows: the reference fixture', () => {
  // flow-plan §4, "Transfer detection — the algorithm": three cases, and they
  // are the whole test. The fixture's own `notes[2]` confirms the February
  // 2026 pair is a genuine inter-account transfer.
  const pairs = findMatchedFlows(fixtureRows);

  it('finds exactly one pair', () => {
    expect(pairs).toHaveLength(1);
  });

  it('finds the 2026-02-15 +7500 / -7500 transfer', () => {
    const p = pairs[0];
    expect(p.contribution.date).toBe('2026-02-15');
    expect(p.withdrawal.date).toBe('2026-02-15');
    expect(p.amount).toBe(7500);
    expect(p.daysApart).toBe(0);
    expect(p.direction).toBe('same-day');
    expect(p.amountDelta).toBe(0);
  });

  it('does not fire on 2024-11-15 +875 / 2025-01-15 -875 — equal, but 61 days apart', () => {
    expect(pairs.some((p) => p.amount === 875)).toBe(false);
  });

  it('does not fire on 2025-01-15 +3500 / -875 — same day, unequal', () => {
    expect(pairs.some((p) => p.contribution.amount === 3500)).toBe(false);
  });

  it('does not fire on 2023-01-15 +6000 / -3000 — same day, unequal', () => {
    expect(pairs.some((p) => p.contribution.amount === 6000)).toBe(false);
  });

  it('says the pair is same-month, so only the gross figures move', () => {
    expect(pairs[0].straddlesMonthBoundary).toBe(false);
    expect(pairs[0].impact).toBe('xirr-only');
  });

  it('addresses rows by index, so the table can strike them through', () => {
    const p = pairs[0];
    expect(fixtureRows[p.contribution.index]).toEqual(
      { date: '2026-02-15', type: 'contribution', amount: 7500 });
    expect(fixtureRows[p.withdrawal.index]).toEqual(
      { date: '2026-02-15', type: 'withdrawal', amount: 7500 });
  });

  it('never mutates the rows it was given', () => {
    const before = JSON.stringify(fixtureRows);
    findMatchedFlows(fixtureRows);
    expect(JSON.stringify(fixtureRows)).toBe(before);
  });
});

// ═════════════════════════════ 2. acceptance — synthetic.test.ts §6 verbatim

describe('findMatchedFlows: acceptance against the engine (synthetic §6)', () => {
  const base: InputRow[] = [
    contribution('2021-10-12', 20_000),
    balance('2021-10-31', 20_000),
    balance('2022-12-31', 21_000),
    balance('2023-12-31', 26_000),
    balance('2024-12-31', 31_000),
    balance('2025-12-31', 36_000),
    balance('2026-07-31', 39_000),
  ];
  const PAIR = 11_375; // the misstatement INTERACTION.md says this caught

  describe('case A — the pair falls inside one calendar month', () => {
    const withPair: InputRow[] = [...base,
      contribution('2023-03-06', PAIR), withdrawal('2023-03-10', PAIR)];
    const pairs = findMatchedFlows(withPair);

    it('detects it, four days apart', () => {
      expect(pairs).toHaveLength(1);
      expect(pairs[0].amount).toBe(PAIR);
      expect(pairs[0].daysApart).toBe(4);
      expect(pairs[0].direction).toBe('in-then-out');
    });

    it('classifies it as same-month, impact xirr-only', () => {
      expect(pairs[0].straddlesMonthBoundary).toBe(false);
      expect(pairs[0].impact).toBe('xirr-only');
    });

    it('and the engine agrees: net, ending and the reference are all unchanged', () => {
      const a = run(base);
      const b = run(withPair);
      expect(b.netContributed).toBe(a.netContributed);
      expect(b.endingValue).toBe(a.endingValue);
      // `replay` nets flows within a calendar month, so the pair cancels
      // exactly and the reference never sees it.
      expect(ref(b).endingValue).toBeCloseTo(ref(a).endingValue, 9);
    });

    it('moves xirr by about 1.7 basis points and nothing more', () => {
      const drift = Math.abs(run(withPair).you.xirr - run(base).you.xirr);
      expect(drift).toBeGreaterThan(0.0001);
      expect(drift).toBeLessThan(0.0002);
    });
  });

  describe('case B — the pair straddles a month boundary', () => {
    // THIS is why detection is in code. Four days apart, either side of
    // 31 March: `replay` hands the reference a full month of return on 11,375
    // that was never invested.
    const straddling: InputRow[] = [...base,
      contribution('2023-03-29', PAIR), withdrawal('2023-04-03', PAIR)];
    const pairs = findMatchedFlows(straddling);

    it('detects it, five days apart', () => {
      expect(pairs).toHaveLength(1);
      expect(pairs[0].amount).toBe(PAIR);
      expect(pairs[0].daysApart).toBe(5);
    });

    it('flags it as straddling — the field the UI must warn on', () => {
      expect(pairs[0].straddlesMonthBoundary).toBe(true);
      expect(pairs[0].impact).toBe('reference-and-xirr');
    });

    it('moves the reference ending value by $434.69', () => {
      const drift = ref(run(straddling)).endingValue - ref(run(base)).endingValue;
      expect(drift).toBeCloseTo(434.69, 2);
    });

    it('and moves headline capture by more than 0.1pp', () => {
      const a = run(base);
      const b = run(straddling);
      expect(Math.abs(b.capture.pctKept - a.capture.pctKept)).toBeGreaterThan(0.001);
      // The user's own numbers are untouched — which is exactly why nobody
      // notices without the detector.
      expect(b.netContributed).toBe(a.netContributed);
      expect(b.endingValue).toBe(a.endingValue);
    });

    it('the two cases differ ONLY in `straddlesMonthBoundary`, on identical amounts', () => {
      const sameMonth = findMatchedFlows([...base,
        contribution('2023-03-06', PAIR), withdrawal('2023-03-10', PAIR)])[0];
      expect(sameMonth.amount).toBe(pairs[0].amount);
      expect(sameMonth.straddlesMonthBoundary).toBe(false);
      expect(pairs[0].straddlesMonthBoundary).toBe(true);
    });
  });
});

// ═══════════════════════════════════════════════════ 3. the parameters

describe('findMatchedFlows: the window', () => {
  const at = (gap: string) => findMatchedFlows([
    contribution('2024-03-01', 5000),
    withdrawal(gap, 5000),
  ]);

  it('defaults to 7 calendar days, per INTERACTION.md', () => {
    expect(TRANSFER_WINDOW_DAYS).toBe(7);
  });

  it('matches at exactly 7 days — inclusive', () => {
    expect(at('2024-03-08')).toHaveLength(1);
    expect(at('2024-03-08')[0].daysApart).toBe(7);
  });

  it('does not match at 8 days', () => {
    expect(at('2024-03-09')).toHaveLength(0);
  });

  it('matches backwards as well as forwards — the withdrawal may come first', () => {
    const p = findMatchedFlows([
      withdrawal('2024-03-01', 5000),
      contribution('2024-03-05', 5000),
    ]);
    expect(p).toHaveLength(1);
    expect(p[0].daysApart).toBe(4);
    expect(p[0].direction).toBe('out-then-in');
  });

  it('is widenable by the caller, for a custodian known to be slow', () => {
    expect(findMatchedFlows([
      contribution('2024-03-01', 5000), withdrawal('2024-03-20', 5000),
    ], { days: 30 })).toHaveLength(1);
  });
});

describe('findMatchedFlows: same-day pairs count', () => {
  // JUDGEMENT, and the fixture settles it: the only confirmed real transfer in
  // the reference data is `2026-02-15 +7500 / -7500`, both legs on one day.
  // Requiring a non-zero gap would miss the case the feature exists for. A
  // same-day round trip through a settlement account is the NORMAL shape of an
  // inter-account transfer, not the exception.
  const rows = [contribution('2024-03-01', 4000), withdrawal('2024-03-01', 4000)];

  it('pairs by default', () => {
    expect(findMatchedFlows(rows)).toHaveLength(1);
    expect(findMatchedFlows(rows)[0].direction).toBe('same-day');
  });

  it('can be switched off by a caller who disagrees', () => {
    expect(findMatchedFlows(rows, { allowSameDay: false })).toHaveLength(0);
  });
});

describe('findMatchedFlows: the amount tolerance', () => {
  const pairAt = (w: number) => findMatchedFlows([
    contribution('2024-03-01', 10_000),
    withdrawal('2024-03-03', w),
  ]);

  it('is max(1 cent, 10 basis points)', () => {
    expect(TRANSFER_ABS_TOLERANCE).toBe(0.01);
    expect(TRANSFER_REL_TOLERANCE).toBe(0.001);
  });

  it('matches exactly equal amounts', () => {
    expect(pairAt(10_000)).toHaveLength(1);
    expect(pairAt(10_000)[0].amountDelta).toBe(0);
  });

  it('matches a leg shaved by a fee inside 10bp — 10,000 out, 9,995 in', () => {
    // A wire fee, a fractional-share liquidation, a receiving custodian
    // rounding to the cent. Still one transfer.
    const p = pairAt(9_995);
    expect(p).toHaveLength(1);
    expect(p[0].amountDelta).toBe(5);
    // The quoted amount is the mean of the legs, not either one.
    expect(p[0].amount).toBe(9_997.5);
  });

  it('does not match 10,000 against 9,900 — 1% apart is two different numbers', () => {
    expect(pairAt(9_900)).toHaveLength(0);
  });

  it('holds a 1-cent floor for small amounts, where 10bp is below a cent', () => {
    expect(findMatchedFlows([
      contribution('2024-03-01', 5.00), withdrawal('2024-03-02', 5.01),
    ])).toHaveLength(1);
    expect(findMatchedFlows([
      contribution('2024-03-01', 5.00), withdrawal('2024-03-02', 5.02),
    ])).toHaveLength(0);
  });

  it('survives float noise on amounts a parser divided', () => {
    expect(findMatchedFlows([
      contribution('2024-03-01', 0.1 + 0.2),
      withdrawal('2024-03-02', 0.3),
    ])).toHaveLength(1);
  });
});

describe('findMatchedFlows: three or more equal flows clustered together', () => {
  // The combinatorial-explosion case, and the one a naive implementation gets
  // wrong. Rule: every row is used at most once, candidates are consumed
  // tightest-gap-first, and the count of rival readings is reported rather
  // than silently discarded.

  it('pairs three equal flows into ONE pair, not three', () => {
    const rows = [
      contribution('2024-03-01', 5000),
      withdrawal('2024-03-02', 5000),
      contribution('2024-03-03', 5000),
    ];
    const p = findMatchedFlows(rows);
    expect(p).toHaveLength(1);
  });

  it('picks the tightest gap and says how many rival readings there were', () => {
    const rows = [
      contribution('2024-03-01', 5000),   // 0
      withdrawal('2024-03-06', 5000),     // 1 — 5 days from row 0
      contribution('2024-03-05', 5000),   // 2 — 1 day from row 1
    ];
    const p = findMatchedFlows(rows);
    expect(p).toHaveLength(1);
    expect(p[0].contribution.index).toBe(2);
    expect(p[0].withdrawal.index).toBe(1);
    expect(p[0].daysApart).toBe(1);
    expect(p[0].competingCandidates).toBeGreaterThan(0);
  });

  it('never uses a row in two pairs', () => {
    const rows = [
      contribution('2024-03-01', 5000),
      contribution('2024-03-02', 5000),
      contribution('2024-03-03', 5000),
      withdrawal('2024-03-04', 5000),
    ];
    const p = findMatchedFlows(rows);
    expect(p).toHaveLength(1);
    const used = p.flatMap((x) => [x.contribution.index, x.withdrawal.index]);
    expect(new Set(used).size).toBe(used.length);
  });

  it('pairs six equal flows into three pairs, not nine', () => {
    const rows = [
      contribution('2024-03-01', 5000), withdrawal('2024-03-02', 5000),
      contribution('2024-03-03', 5000), withdrawal('2024-03-04', 5000),
      contribution('2024-03-05', 5000), withdrawal('2024-03-06', 5000),
    ];
    const p = findMatchedFlows(rows);
    expect(p).toHaveLength(3);
    const used = p.flatMap((x) => [x.contribution.index, x.withdrawal.index]);
    expect(new Set(used).size).toBe(6);
  });

  it('reports zero rivals when the match is unambiguous', () => {
    const p = findMatchedFlows([
      contribution('2024-03-01', 5000), withdrawal('2024-03-03', 5000),
    ]);
    expect(p[0].competingCandidates).toBe(0);
  });

  it('does not blow up on 200 equal flows a day apart', () => {
    const rows: InputRow[] = [];
    for (let i = 0; i < 200; i++) {
      const day = String((i % 28) + 1).padStart(2, '0');
      rows.push(i % 2 === 0
        ? contribution(`2024-03-${day}`, 1000)
        : withdrawal(`2024-03-${day}`, 1000));
    }
    const p = findMatchedFlows(rows);
    expect(p.length).toBeLessThanOrEqual(100);
    const used = p.flatMap((x) => [x.contribution.index, x.withdrawal.index]);
    expect(new Set(used).size).toBe(used.length);
  });
});

describe('findMatchedFlows: what it ignores', () => {
  it('ignores balance rows entirely', () => {
    expect(findMatchedFlows([
      balance('2024-03-01', 5000), balance('2024-03-02', 5000),
    ])).toHaveLength(0);
  });

  it('never pairs two contributions or two withdrawals', () => {
    expect(findMatchedFlows([
      contribution('2024-03-01', 5000), contribution('2024-03-02', 5000),
    ])).toHaveLength(0);
    expect(findMatchedFlows([
      withdrawal('2024-03-01', 5000), withdrawal('2024-03-02', 5000),
    ])).toHaveLength(0);
  });

  it('ignores zero flows, which would otherwise pair with each other', () => {
    expect(findMatchedFlows([
      contribution('2024-03-01', 0), withdrawal('2024-03-02', 0),
    ])).toHaveLength(0);
  });

  it('ignores a row with an unparseable date instead of throwing', () => {
    const rows = [
      { date: '2024-1-5', type: 'contribution', amount: 5000 },
      { date: '2024-01-06', type: 'withdrawal', amount: 5000 },
    ] as InputRow[];
    expect(() => findMatchedFlows(rows)).not.toThrow();
    expect(findMatchedFlows(rows)).toHaveLength(0);
  });

  it('ignores a non-finite amount instead of throwing', () => {
    const rows = [
      { date: '2024-03-01', type: 'contribution', amount: NaN },
      { date: '2024-03-02', type: 'withdrawal', amount: NaN },
    ] as InputRow[];
    expect(() => findMatchedFlows(rows)).not.toThrow();
    expect(findMatchedFlows(rows)).toHaveLength(0);
  });

  it('returns an empty array for no rows at all', () => {
    expect(findMatchedFlows([])).toEqual([]);
  });
});

describe('findMatchedFlows: output order and determinism', () => {
  const rows: InputRow[] = [
    contribution('2025-06-01', 2000), withdrawal('2025-06-03', 2000),
    contribution('2024-01-10', 900), withdrawal('2024-01-12', 900),
  ];

  it('returns pairs in chronological order, matching the table', () => {
    const p = findMatchedFlows(rows);
    expect(p.map((x) => x.contribution.date)).toEqual(['2024-01-10', '2025-06-01']);
  });

  it('gives the same answer twice', () => {
    expect(findMatchedFlows(rows)).toEqual(findMatchedFlows(rows));
  });

  it('finds the same pairs whatever order the rows arrive in', () => {
    const key = (p: ReturnType<typeof findMatchedFlows>) =>
      p.map((x) => `${x.contribution.date}/${x.withdrawal.date}/${x.amount}`).sort();
    expect(key(findMatchedFlows([...rows].reverse()))).toEqual(key(findMatchedFlows(rows)));
  });
});
