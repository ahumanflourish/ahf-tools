/**
 * Public surface of @ahumanflourish/portfolio-extract.
 *
 * Three things, in the order a caller meets them: the schema Claude is
 * constrained to, the prompt that carries the judgement the schema cannot, and
 * the single call that sends both and classifies what comes back.
 *
 * Nothing here touches the maths. The extraction lands in the review table and
 * never passes it.
 */

export {
  EXTRACTION_SCHEMA,
  extractionSchema,
  SCHEMA_VERSION,
  ROW_TYPES,
  AMOUNT_CONFIDENCE,
  DATE_CONFIDENCE,
  EXCLUSION_REASONS,
} from './schema';

export { EXTRACTION_SYSTEM, EXTRACTION_USER_TEXT, reextractionUserText } from './prompt';

export {
  extract,
  buildRequestBody,
  normaliseBase64,
  DEFAULT_MODEL,
  DEFAULT_MAX_TOKENS,
  DEFAULT_TIMEOUT_MS,
  MAX_BASE64_BYTES,
  MESSAGES_ENDPOINT,
} from './extract';

export {
  validateExtraction,
  validateAgainstSchema,
  isCalendarDate,
  crossCheck,
  recomputeSummary,
  toInputRows,
  ENUMS,
} from './validate';

export type {
  Attachment,
  ExtractInput,
  ExtractOptions,
  ExtractOutcome,
  FetchLike,
  TokenUsage,
} from './extract';

export type {
  ExtractionWarning,
  RecomputedSummary,
  ValidationIssue,
  IssueCode,
  WarningCode,
} from './validate';

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
  InputRowLike,
  RowType,
  UnreadableItem,
} from './types';
