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

export type {
  AnalysisErrorCode,
  InputRow,
  Holding,
  PortfolioInput,
  BenchmarkData,
  StrategyDef,
  StrategyResult,
  PeriodInfo,
  Granularity,
  DataQuality,
  Finding,
  MarketWeight,
  AnalysisResult,
} from './engine';
