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

/**
 * The whole core surface, re-exported wholesale.
 *
 * DELIBERATELY A STAR, NOT A LIST. This file used to name each symbol by hand,
 * and the list went stale: `AnalysisError`, `benchmarkCoverage`,
 * `classifyGranularity`, `dataQualityWarnings`, `GRANULARITY_MAX_INTERVAL` and
 * `DEFAULT_MARKET_WEIGHT_WINDOW` were all reachable in the ESM library and all
 * sitting inside the bundle, and none of them were on the global — so the
 * offline page and the artifact payload could run an analysis but could not
 * catch its error, ask what the supported window was, or regenerate a single
 * line of the data-quality copy. Every one of those is exactly what a review
 * table and every error path need.
 *
 * A star export cannot drift: `src/index.ts` is the one place the public
 * surface is decided, and this target now has it by construction rather than
 * by transcription. The four locals above (`benchmarks`, `strategies`,
 * `referenceId`, `fixture`) and `runFixture` are additions to that surface,
 * not overrides — no name here collides with one in core.
 */
export * from '../../core/src/index';
