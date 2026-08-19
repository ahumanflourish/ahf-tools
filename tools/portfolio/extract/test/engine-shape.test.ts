/**
 * The hand-off to the engine.
 *
 * This package does not import `core`, deliberately: it has to build and run
 * standalone inside a published artifact, where there is no module graph. The
 * cost of that is a structural restatement of `InputRow` in `types.ts` that
 * could drift from the real one without anything noticing until a number came
 * out wrong.
 *
 * So the test imports the real type — a type-only import, erased at build, that
 * exists solely so the compiler fails when the two shapes part company. If this
 * file stops compiling, `toInputRows` is producing something `analyse` no
 * longer takes.
 */

import { describe, expect, it } from 'vitest';

import type { InputRow } from '../../core/src/index';
import { toInputRows } from '../src/validate';
import type { InputRowLike } from '../src/types';
import { VALID } from './fixtures';

describe('InputRowLike tracks the engine’s InputRow', () => {
  it('is assignable to InputRow in both directions', () => {
    const fromExtraction: InputRowLike[] = toInputRows(VALID.rows);
    const toEngine: InputRow[] = fromExtraction;
    const backAgain: InputRowLike[] = toEngine;
    expect(backAgain).toHaveLength(VALID.rows.length);
  });

  it('carries the three canonical type values and nothing else', () => {
    const balance: InputRow = { date: '2021-12-31', type: 'balance', amount: 1 };
    const contribution: InputRow = { date: '2021-12-31', type: 'contribution', amount: 1 };
    const withdrawal: InputRow = { date: '2021-12-31', type: 'withdrawal', amount: 1 };
    for (const row of [balance, contribution, withdrawal]) {
      const asLike: InputRowLike = row;
      expect(asLike.amount).toBe(1);
    }
  });

  it('produces dates the engine can turn into a real Date', () => {
    for (const row of toInputRows(VALID.rows)) {
      const d = new Date(`${row.date}T00:00:00Z`);
      expect(Number.isNaN(d.getTime()), row.date).toBe(false);
    }
  });
});
