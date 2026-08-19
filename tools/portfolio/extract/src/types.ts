/**
 * The types the rest of the flow reads, in one place.
 *
 * `InputRowLike` is a structural restatement of the engine's `InputRow` rather
 * than an import of it. This package must build and run standalone — inside a
 * published artifact, where there is no module graph to resolve — so it does
 * not take a dependency on `core`. The shape is pinned by
 * `test/engine-shape.test.ts`, which fails if the two ever drift.
 */

export type {
  AmountConfidence,
  DateConfidence,
  ExclusionReason,
  ExcludedEntry,
  ExtractedHolding,
  ExtractedHoldings,
  ExtractedRow,
  ExtractionResult,
  ExtractionSummary,
  RowType,
  UnreadableItem,
} from './schema';

import type { RowType } from './schema';

/** Structurally identical to `InputRow` in `core/src/engine.ts`. */
export type InputRowLike = { date: string; type: RowType; amount: number };
