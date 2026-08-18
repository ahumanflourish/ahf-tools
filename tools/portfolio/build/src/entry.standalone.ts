/**
 * Standalone entry for the two self-contained targets (offline HTML, artifact
 * payload).
 *
 * The core package is pure ESM with zero runtime dependencies and reads its
 * data through the caller, so "self-contained" here just means: import the
 * engine, import the JSON, and let esbuild inline both into one IIFE. Nothing
 * in this file may reach for the network, the filesystem, or a timer — that is
 * the whole point of the target.
 *
 * Everything the core exports is re-exposed under one global so a page (or a
 * pasted artifact blob) can call `PortfolioCore.analyse(...)` with no module
 * loader present.
 */
import * as core from '../../core/src/index';
import type {
  AnalysisResult,
  BenchmarkData,
  PortfolioInput,
  StrategyDef,
} from '../../core/src/index';

import benchmarksJson from '../../core/src/data/benchmarks.json';
import strategiesJson from '../../core/src/data/strategies.json';
import fixturesJson from '../../core/src/data/fixtures.json';

/** Benchmark monthly series, inlined at build time. */
export const benchmarks = benchmarksJson as unknown as BenchmarkData;

/** Strategy definitions, inlined at build time. */
export const strategies = (strategiesJson as { strategies: unknown[] })
  .strategies as unknown as StrategyDef[];

/** Id of the passive reference strategy the capture block is measured against. */
export const referenceId = (strategiesJson as { defaultReference: string })
  .defaultReference;

/**
 * The reference fixture, inlined so the offline page has something real to run
 * without asking the user for a file. `holdings` sits beside `input` in the
 * fixture but the engine takes it as part of PortfolioInput.
 */
const fixtureRaw = fixturesJson as unknown as {
  name: string;
  description: string;
  input: Omit<PortfolioInput, 'holdings'>;
  holdings: NonNullable<PortfolioInput['holdings']>;
  expected: { endingValue: number } & Record<string, unknown>;
};

export const fixture = {
  name: fixtureRaw.name,
  description: fixtureRaw.description,
  input: { ...fixtureRaw.input, holdings: fixtureRaw.holdings } as PortfolioInput,
  expected: fixtureRaw.expected,
};

/**
 * Run the bundled fixture through the bundled data. Convenience for the
 * offline page and the acceptance check; the general case is `analyse`.
 */
export function runFixture(): AnalysisResult {
  return core.analyse(fixture.input, benchmarks, strategies, referenceId);
}

export const {
  analyse,
  deriveFindings,
  impliedUsMarketWeight,
  FALLBACK_US_MARKET_WEIGHT,
  REGIONAL_TILT_THRESHOLD,
  buildStrategySeries,
  replay,
  findFlowFreeWindows,
  xirr,
  modifiedDietz,
  toDate,
  ym,
  daysBetween,
  yearsBetween,
  monthRange,
  monthEnd,
} = core;

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
} from '../../core/src/index';
