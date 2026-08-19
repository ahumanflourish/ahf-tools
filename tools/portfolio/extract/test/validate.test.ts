/**
 * The value layer: what a structurally valid extraction still gets warned about.
 *
 * The distinction being asserted throughout is that a shape problem fails the
 * call and a value problem does not. Two hundred good rows must not be thrown
 * away because one balance came back as zero — the review table is the source
 * of truth by construction, and a warning on one cell is a better outcome than
 * a blank screen.
 *
 * The summary cross-check gets the most attention here because it is the one
 * free catch in the whole design: the model's own totals, recomputed from the
 * model's own rows, catch a class of error no schema can see.
 */

import { describe, expect, it } from 'vitest';

import { crossCheck, recomputeSummary, toInputRows } from '../src/validate';
import type { ExtractionResult } from '../src/types';
import { clone, VALID, VALID_EMPTY } from './fixtures';

/** Fixed clock, so the future-date check cannot flip at midnight. */
const NOW = new Date('2026-08-19T12:00:00Z');

const codes = (r: ExtractionResult) =>
  crossCheck(r, NOW).warnings.map((w) => w.code);

describe('recomputeSummary', () => {
  it('reproduces the model’s own summary when the model was honest', () => {
    const recomputed = recomputeSummary(VALID);
    expect(recomputed.totalContributed).toBe(VALID.summary.totalContributed);
    expect(recomputed.totalWithdrawn).toBe(VALID.summary.totalWithdrawn);
    expect(recomputed.netInvested).toBe(VALID.summary.netInvested);
    expect(recomputed.rowCount).toBe(VALID.summary.rowCount);
    expect(recomputed.balanceCount).toBe(VALID.summary.balanceCount);
    expect(recomputed.transfersExcluded).toBe(VALID.summary.transfersExcluded);
    expect(recomputed.datesInferred).toBe(VALID.summary.datesInferred);
    expect(recomputed.amountsNotReadDirectly).toBe(
      VALID.summary.amountsNotReadDirectly,
    );
    expect(recomputed.accounts).toEqual(VALID.summary.accounts);
    expect(recomputed.currencies).toEqual(VALID.summary.currencies);
    expect(recomputed.firstDate).toBe(VALID.summary.firstDate);
    expect(recomputed.lastDate).toBe(VALID.summary.lastDate);
  });

  it('rounds money to the cent so float noise is not a disagreement', () => {
    const r = clone(VALID);
    r.rows.push({
      date: '2023-05-01',
      type: 'contribution',
      amount: 0.1,
      currency: 'USD',
      amountConfidence: 'read',
      dateConfidence: 'read',
      account: 'IRA ...9087',
      source: 'p1',
      note: '',
    });
    r.rows.push({
      date: '2023-05-02',
      type: 'contribution',
      amount: 0.2,
      currency: 'USD',
      amountConfidence: 'read',
      dateConfidence: 'read',
      account: 'IRA ...9087',
      source: 'p1',
      note: '',
    });
    expect(recomputeSummary(r).totalContributed).toBe(13000.3);
  });
});

describe('the summary cross-check', () => {
  it('is silent when the model’s totals match its own rows', () => {
    expect(codes(VALID)).not.toContain('summary-mismatch');
  });

  it('fires when a stated money total is wrong', () => {
    const r = clone(VALID);
    r.summary.totalContributed = 20500;
    const { warnings } = crossCheck(r, NOW);
    const w = warnings.find((x) => x.code === 'summary-mismatch');
    expect(w).toBeDefined();
    expect(w!.message).toContain('totalContributed: said 20500, rows give 13000');
  });

  it('fires when a stated count is wrong', () => {
    const r = clone(VALID);
    r.summary.transfersExcluded = 1;
    expect(codes(r)).toContain('summary-mismatch');
  });

  it('fires when a stated boundary date is wrong', () => {
    const r = clone(VALID);
    r.summary.lastDate = '2024-12-31';
    expect(codes(r)).toContain('summary-mismatch');
  });

  it('tolerates a cent of rounding on money but nothing on counts', () => {
    const money = clone(VALID);
    money.summary.netInvested = 13000.01;
    expect(codes(money)).not.toContain('summary-mismatch');

    const count = clone(VALID);
    count.summary.rowCount = 6;
    expect(codes(count)).toContain('summary-mismatch');
  });

  it('never fails the extraction — a mismatch is a warning, not an issue', () => {
    const r = clone(VALID);
    r.summary.totalContributed = 0;
    const { warnings } = crossCheck(r, NOW);
    expect(warnings.every((w) => w.severity !== 'error')).toBe(true);
  });
});

describe('row-level value warnings', () => {
  it('treats a non-positive balance as blocking and a zero flow as a warning', () => {
    const r = clone(VALID);
    r.rows[1].amount = 0;
    r.rows[0].amount = 0;
    const { warnings } = crossCheck(r, NOW);
    const balance = warnings.find((w) => w.code === 'non-positive-balance');
    const flow = warnings.find((w) => w.code === 'non-positive-amount');
    expect(balance?.severity).toBe('error');
    expect(flow?.severity).toBe('warning');
  });

  it('catches a future date', () => {
    const r = clone(VALID);
    r.rows[4].date = '2027-01-01';
    const w = crossCheck(r, NOW).warnings.find((x) => x.code === 'future-date');
    expect(w?.severity).toBe('error');
    expect(w?.path).toBe('rows[4]');
  });

  it('accepts today but not tomorrow', () => {
    const today = clone(VALID);
    today.rows[4].date = '2026-08-19';
    expect(codes(today)).not.toContain('future-date');

    const tomorrow = clone(VALID);
    tomorrow.rows[4].date = '2026-08-20';
    expect(codes(tomorrow)).toContain('future-date');
  });

  it('flags a duplicate date/type/amount triple, naming both rows', () => {
    const r = clone(VALID);
    r.rows.push(clone(r.rows[1]));
    const w = crossCheck(r, NOW).warnings.find((x) => x.code === 'duplicate-row');
    expect(w?.message).toContain('rows 1 and 5');
  });

  it('blocks on mixed real currencies but not on UNKNOWN alongside one real one', () => {
    const mixed = clone(VALID);
    mixed.rows[0].currency = 'GBP';
    const w = crossCheck(mixed, NOW).warnings.find((x) => x.code === 'mixed-currency');
    expect(w?.severity).toBe('error');

    const unknown = clone(VALID);
    unknown.rows[0].currency = 'UNKNOWN';
    const c = codes(unknown);
    expect(c).not.toContain('mixed-currency');
    expect(c).toContain('unknown-currency');
  });
});

describe('structural warnings the table gates compute on', () => {
  it('reports zero rows as blocking', () => {
    const w = crossCheck(VALID_EMPTY, NOW).warnings.find((x) => x.code === 'no-rows');
    expect(w?.severity).toBe('error');
  });

  it('reports fewer than two balances as blocking, and says how many there are', () => {
    const r = clone(VALID);
    r.rows = r.rows.filter((row) => row.type !== 'balance').concat(
      r.rows.filter((row) => row.type === 'balance').slice(0, 1),
    );
    const w = crossCheck(r, NOW).warnings.find((x) => x.code === 'too-few-balances');
    expect(w?.severity).toBe('error');
    expect(w?.message).toContain('Only 1 balance row');
  });

  it('does not complain about balance count when there are no rows at all', () => {
    expect(codes(VALID_EMPTY)).not.toContain('too-few-balances');
  });

  it('surfaces an unmatched internal-transfer leg', () => {
    const r = clone(VALID);
    r.excluded[0].pairedWith = '';
    const w = crossCheck(r, NOW).warnings.find(
      (x) => x.code === 'unmatched-transfer-leg',
    );
    expect(w?.path).toBe('excluded[0]');
  });

  it('surfaces unreadable content so the list is never silently swallowed', () => {
    expect(codes(VALID)).toContain('unreadable-content');
  });

  it('flags a holdings snapshot dated outside the history it anchors', () => {
    const inside = clone(VALID);
    expect(codes(inside)).not.toContain('holdings-asof-outside-history');

    const outside = clone(VALID);
    outside.holdings!.asOf = '2026-08-01';
    expect(codes(outside)).toContain('holdings-asof-outside-history');
  });

  it('flags a schema version this build was not written for', () => {
    const r = clone(VALID);
    r.schemaVersion = 99;
    expect(codes(r)).toContain('schema-version-mismatch');
  });
});

describe('toInputRows', () => {
  it('strips every UI-layer field and keeps the engine triple', () => {
    const rows = toInputRows(VALID.rows);
    expect(rows).toHaveLength(VALID.rows.length);
    for (const row of rows) {
      expect(Object.keys(row).sort()).toEqual(['amount', 'date', 'type']);
    }
    expect(rows[0]).toEqual({
      date: '2021-10-12',
      type: 'contribution',
      amount: 10000,
    });
  });

  it('does not mutate or reorder the extraction', () => {
    const before = clone(VALID.rows);
    toInputRows(VALID.rows);
    expect(VALID.rows).toEqual(before);
  });
});
