/**
 * Public surface of @ahumanflourish/portfolio-core.
 *
 * The engine is a single pure module with no runtime dependencies, so the
 * barrel is a straight re-export of everything it exposes: the entry point
 * `analyse`, the findings derivation, the maths primitives (useful for
 * testing and for UI-side recomputation), the date helpers, and the types.
 */

export {
  // main entry
  analyse,
  deriveFindings,
  // input validation — the catchable error `analyse` refuses with, and the
  // benchmark window that decides two of its four codes
  AnalysisError,
  benchmarkCoverage,
  // input description — everything a set of rows says about itself, with no
  // benchmark data, no strategy selection and no analysis. `analyse` calls it;
  // the review table calls it on every keystroke.
  describeInput,
  // data quality — the classifier and the warning copy, exported so a UI can
  // recompute both after the user edits the review table
  classifyGranularity,
  dataQualityWarnings,
  GRANULARITY_MAX_INTERVAL,
  // market weight (derived, not sourced — see engine.ts)
  impliedUsMarketWeight,
  FALLBACK_US_MARKET_WEIGHT,
  DEFAULT_MARKET_WEIGHT_WINDOW,
  REGIONAL_TILT_THRESHOLD,
  // expense ratios — the catalogue value, the user's override, and the
  // conversion from a fund's published all-in figure to the drag on top
  embeddedExpenseRatio,
  extraDrag,
  resolveExpenseRatio,
  // strategy construction and replay
  buildStrategySeries,
  replay,
  findFlowFreeWindows,
  // return maths
  xirr,
  modifiedDietz,
  // date helpers
  toDate,
  ym,
  daysBetween,
  yearsBetween,
  monthRange,
  monthEnd,
} from './engine';

export {
  // CSV / pasted-text parsing (Path B, and the landing surface for Path C)
  parseRows,
  splitFields,
  parseAmount,
  scanDate,
  resolveType,
} from './parse';

export type {
  ParseResult,
  ParseOptions,
  ParseOutcome,
  ParsedRow,
  ParseAmbiguity,
  ParseAssumptions,
  ParseStats,
  SkippedLine,
  SkipReason,
  IgnoredLine,
  AmbiguityExample,
  Delimiter,
  DateFormatName,
} from './parse';

export {
  // internal-transfer detection — INTERACTION.md, review table
  findMatchedFlows,
  TRANSFER_WINDOW_DAYS,
  TRANSFER_ABS_TOLERANCE,
  TRANSFER_REL_TOLERANCE,
} from './transfers';

export type {
  MatchedFlow,
  MatchedLeg,
  FindMatchedFlowsOptions,
} from './transfers';

/**
 * The constructed target-date reference. Data-injected like everything else
 * here: `glide-path.json` ships beside `benchmarks.json` and is passed in, so
 * a consumer that never offers a target-date comparison never carries the
 * table. `strategies.json`'s `targetDate` block supplies the copy.
 */
export {
  glideWeights,
  scheduleFor,
  decimalYearOfMonthEnd,
  targetDateStrategy,
  targetDateReferences,
  TARGET_DATE_SERIES,
} from './glide';

export type {
  AnalysisErrorCode,
  InputRow,
  Holding,
  PortfolioInput,
  BenchmarkData,
  StrategyDef,
  StrategyResult,
  FundRef,
  ExpenseRatio,
  PeriodInfo,
  Granularity,
  DataQuality,
  InputDataQuality,
  InputDescription,
  Finding,
  MarketWeight,
  AnalysisResult,
} from './engine';

export type {
  GlidePoint,
  GlideSchedule,
  GlideSource,
  GlidePathData,
  TargetDateTemplate,
} from './glide';
