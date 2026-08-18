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
  // market weight (derived, not sourced — see engine.ts)
  impliedUsMarketWeight,
  FALLBACK_US_MARKET_WEIGHT,
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
  InputRow,
  Holding,
  PortfolioInput,
  BenchmarkData,
  StrategyDef,
  StrategyResult,
  Finding,
  MarketWeight,
  AnalysisResult,
} from './engine';
