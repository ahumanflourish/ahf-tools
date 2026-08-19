/**
 * Client-side validation of whatever came back.
 *
 * WHY THIS EXISTS AT ALL, GIVEN `output_config.format`. Because enforcement
 * shapes generation and does not guarantee it. Three measured or documented
 * facts make that concrete:
 *
 *  1. `stop_reason: "max_tokens"` yields schema-SHAPED but truncated JSON. The
 *     call module catches that one by `stop_reason` before it reaches here, but
 *     it is the existence proof that the guarantee is about shape, not output.
 *  2. The proxy silently serves `claude-sonnet-4-6`, which is not on the
 *     documented structured-outputs support list. The A/B says `output_config`
 *     changes generation on it; it does not say the change is a hard grammar
 *     constraint rather than the schema being read as instruction.
 *  3. If the proxy ever stops honouring `output_config`, it will do so
 *     silently. This module is what turns that from a wrong answer into a
 *     `schema-mismatch`.
 *
 * TWO KINDS OF PROBLEM, DELIBERATELY SEPARATED.
 *
 * `validateExtraction` returns SHAPE issues. A shape issue means the reply is
 * not an `ExtractionResult` and nothing may read it — a wrong enum, a missing
 * field, an extra property, `2025-02-30`. These fail the call.
 *
 * `crossCheck` returns VALUE warnings. A negative balance, a future date, a
 * duplicate triple, a summary whose totals disagree with the rows they claim to
 * summarise. These do NOT fail the call, because the review table is the source
 * of truth by construction and a user fixing one cell is a better outcome than
 * discarding two hundred good rows. They are handed to the table to render.
 *
 * That split is the whole reason the summary is worth asking for. The table
 * recomputes every figure the model reports; when the two disagree, that is a
 * red banner — "Claude's totals do not match the rows it produced" — and it
 * catches a class of extraction error no schema can see, for free.
 *
 * AND ONE THING THAT IS NEITHER: `normaliseAmounts`. A signed amount is the one
 * value-level problem where leaving the number alone produces a SILENT wrong
 * answer rather than a visible one, so it is corrected rather than merely
 * reported. It is the only place in this package that changes a model's number,
 * and it never does so quietly.
 */

import {
  AMOUNT_CONFIDENCE,
  DATE_CONFIDENCE,
  EXCLUSION_REASONS,
  EXTRACTION_SCHEMA,
  ROW_TYPES,
  SCHEMA_VERSION,
} from './schema';
import type {
  ExcludedEntry,
  ExtractionResult,
  ExtractedRow,
  InputRowLike,
} from './types';

/* ───────────────────────────────────────────────────────── shape issues */

export type IssueCode =
  | 'not-an-object'
  | 'wrong-type'
  | 'missing-property'
  | 'unexpected-property'
  | 'not-in-enum'
  | 'wrong-const'
  | 'not-an-integer'
  | 'not-finite'
  | 'not-a-date'
  | 'no-matching-variant';

export interface ValidationIssue {
  /** JSON-pointer-ish path: `rows[3].date`. Empty string means the root. */
  path: string;
  code: IssueCode;
  message: string;
}

type JsonSchema = Record<string, unknown>;

const typeName = (v: unknown): string => {
  if (v === null) return 'null';
  if (Array.isArray(v)) return 'array';
  return typeof v;
};

/**
 * `format: "date"` in the API's schema subset checks the lexical shape. It does
 * not check that the day exists, and the engine's `toDate` is
 * `new Date(s + 'T00:00:00Z')`, which turns `2024-1-5` into `Invalid Date` and
 * propagates `NaN` through the maths with no error at all. So this is strict:
 * exactly ten characters, zero-padded, and a real day in a real month.
 */
export function isCalendarDate(value: unknown): value is string {
  if (typeof value !== 'string') return false;
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(value);
  if (!m) return false;
  const [y, mo, d] = [Number(m[1]), Number(m[2]), Number(m[3])];
  if (mo < 1 || mo > 12 || d < 1) return false;
  const dim = new Date(Date.UTC(y, mo, 0)).getUTCDate();
  return d <= dim;
}

function checkType(
  value: unknown,
  expected: string,
  path: string,
  issues: ValidationIssue[],
): boolean {
  const actual = typeName(value);
  if (expected === 'integer') {
    if (actual !== 'number') {
      issues.push({
        path,
        code: 'wrong-type',
        message: `expected integer, got ${actual}`,
      });
      return false;
    }
    if (!Number.isFinite(value as number)) {
      issues.push({ path, code: 'not-finite', message: 'number is not finite' });
      return false;
    }
    if (!Number.isInteger(value as number)) {
      issues.push({
        path,
        code: 'not-an-integer',
        message: `expected an integer, got ${String(value)}`,
      });
      return false;
    }
    return true;
  }
  if (actual !== expected) {
    issues.push({
      path,
      code: expected === 'object' && actual !== 'object' ? 'wrong-type' : 'wrong-type',
      message: `expected ${expected}, got ${actual}`,
    });
    return false;
  }
  if (expected === 'number' && !Number.isFinite(value as number)) {
    issues.push({ path, code: 'not-finite', message: 'number is not finite' });
    return false;
  }
  return true;
}

/**
 * Validate a value against the supported schema subset:
 * `type` (including `integer`), `const`, `enum`, `format: "date"`, `properties`,
 * `required`, `additionalProperties: false`, `items`, `anyOf`.
 *
 * Nothing else is supported, because nothing else is used — a validator that
 * silently ignores a keyword the schema author believed was enforced is the
 * same failure mode this module exists to prevent.
 */
export function validateAgainstSchema(
  value: unknown,
  schema: JsonSchema,
  path = '',
): ValidationIssue[] {
  const issues: ValidationIssue[] = [];

  if (Array.isArray(schema.anyOf)) {
    const variants = schema.anyOf as JsonSchema[];
    const perVariant = variants.map((v) => validateAgainstSchema(value, v, path));
    if (perVariant.some((i) => i.length === 0)) return issues;

    // A bare "matches none of the permitted shapes" at the union's own path is
    // useless to a UI: for a nullable holdings block it says `holdings` is
    // wrong when in fact one position is missing its account. So when exactly
    // one variant is even the right KIND of thing, report that variant's own
    // issues at their own paths, and keep the union message only for the case
    // where nothing fits at all.
    const actual = typeName(value);
    const fitting = variants
      .map((v, i) => ({ v, i }))
      .filter(({ v }) => v.type === actual || (v.type === 'integer' && actual === 'number'));
    if (fitting.length === 1) return perVariant[fitting[0].i];

    issues.push({
      path,
      code: 'no-matching-variant',
      message: `value (${actual}) matches none of the ${variants.length} permitted shapes`,
    });
    return issues;
  }

  if ('const' in schema) {
    if (value !== schema.const) {
      issues.push({
        path,
        code: 'wrong-const',
        message: `expected ${JSON.stringify(schema.const)}, got ${JSON.stringify(value)}`,
      });
      return issues;
    }
  }

  const expected = schema.type as string | undefined;
  if (expected && !checkType(value, expected, path, issues)) return issues;

  if (Array.isArray(schema.enum)) {
    const allowed = schema.enum as unknown[];
    if (!allowed.includes(value)) {
      issues.push({
        path,
        code: 'not-in-enum',
        message: `${JSON.stringify(value)} is not one of ${allowed.map((a) => JSON.stringify(a)).join(', ')}`,
      });
      return issues;
    }
  }

  if (schema.format === 'date' && !isCalendarDate(value)) {
    issues.push({
      path,
      code: 'not-a-date',
      message: `${JSON.stringify(value)} is not a real calendar date in YYYY-MM-DD form`,
    });
    return issues;
  }

  if (expected === 'object') {
    const obj = value as Record<string, unknown>;
    const props = (schema.properties ?? {}) as Record<string, JsonSchema>;
    const required = (schema.required ?? []) as string[];

    for (const key of required) {
      if (!Object.prototype.hasOwnProperty.call(obj, key)) {
        issues.push({
          path: path ? `${path}.${key}` : key,
          code: 'missing-property',
          message: `required property "${key}" is absent`,
        });
      }
    }
    if (schema.additionalProperties === false) {
      for (const key of Object.keys(obj)) {
        if (!Object.prototype.hasOwnProperty.call(props, key)) {
          issues.push({
            path: path ? `${path}.${key}` : key,
            code: 'unexpected-property',
            message: `property "${key}" is not part of the contract`,
          });
        }
      }
    }
    for (const [key, sub] of Object.entries(props)) {
      if (!Object.prototype.hasOwnProperty.call(obj, key)) continue;
      issues.push(
        ...validateAgainstSchema(obj[key], sub, path ? `${path}.${key}` : key),
      );
    }
    return issues;
  }

  if (expected === 'array' && schema.items) {
    const arr = value as unknown[];
    const items = schema.items as JsonSchema;
    arr.forEach((entry, i) => {
      issues.push(...validateAgainstSchema(entry, items, `${path}[${i}]`));
    });
  }

  return issues;
}

/**
 * Validate a parsed reply against the extraction contract.
 *
 * Returns the value narrowed to `ExtractionResult` only when there is not a
 * single shape issue. There is no partial success: a caller holding a result
 * with `issues.length > 0` would be holding something the type system claims is
 * an `ExtractionResult` and that is not one.
 */
export function validateExtraction(
  value: unknown,
): { ok: true; result: ExtractionResult } | { ok: false; issues: ValidationIssue[] } {
  const issues = validateAgainstSchema(value, EXTRACTION_SCHEMA as unknown as JsonSchema);
  if (issues.length > 0) return { ok: false, issues };
  return { ok: true, result: value as unknown as ExtractionResult };
}

/* ────────────────────────────────────────────────────── value warnings */

export type WarningCode =
  | 'no-rows'
  | 'too-few-balances'
  | 'non-positive-amount'
  | 'non-positive-balance'
  | 'negative-amount'
  | 'future-date'
  | 'duplicate-row'
  | 'mixed-currency'
  | 'unknown-currency'
  | 'summary-mismatch'
  | 'unmatched-transfer-leg'
  | 'unreadable-content'
  | 'holdings-asof-outside-history'
  | 'schema-version-mismatch';

export interface ExtractionWarning {
  code: WarningCode;
  /** `error` blocks compute; `warning` is shown; `info` is a note. */
  severity: 'error' | 'warning' | 'info';
  message: string;
  /** Where it is, when it is about one row. */
  path?: string;
}

/** Recomputed figures, for the table to show beside the model's own. */
export interface RecomputedSummary {
  totalContributed: number;
  totalWithdrawn: number;
  netInvested: number;
  rowCount: number;
  balanceCount: number;
  contributionCount: number;
  withdrawalCount: number;
  transfersExcluded: number;
  datesInferred: number;
  amountsNotReadDirectly: number;
  accounts: string[];
  currencies: string[];
  firstDate: string | null;
  lastDate: string | null;
}

const round2 = (n: number) => Math.round(n * 100) / 100;

/* ─────────────────────────────────────────────── the sign convention */

/** One amount whose sign was corrected, with both numbers kept. */
export interface AmountCorrection {
  /** `rows[3]` or `excluded[2]`. */
  path: string;
  where: 'rows' | 'excluded';
  index: number;
  /** As the model typed it. */
  type: ExtractedRow['type'];
  from: number;
  to: number;
}

/**
 * Make every amount positive, and say so loudly.
 *
 * THE PROBLEM THIS SOLVES, AND WHY IT IS DIFFERENT FROM EVERY OTHER CHECK.
 * The contract is that all three row types carry POSITIVE amounts and that
 * direction is given by `type`. The schema cannot enforce it: `minimum` is not
 * in the API's supported subset and is dropped SILENTLY, so a schema carrying
 * it would read as if it validated the range and would not. And the model's
 * instinct runs the other way — probe batch 2 returned `amount: -450.00` for a
 * withdrawal on a one-page document.
 *
 * A negative withdrawal that reaches the engine is subtracted as a negative:
 * money leaving becomes money arriving, and the direction is counted twice in
 * opposite senses. Nothing downstream can see it. It is a plausible wrong
 * number the user will believe, which is the exact failure class this whole
 * tool exists to catch.
 *
 * NORMALISE OR REJECT? Normalise, and gate.
 *
 *  - Rejecting means a schema-mismatch on the whole extraction: two hundred
 *    good rows discarded because one sign convention slipped. That is a bad
 *    trade against a review table that exists precisely to let a person fix
 *    one cell.
 *  - The MAGNITUDE is never in doubt. |−450| is 450 under every reading.
 *  - The DIRECTION is. There are two ways to write `-450` on a withdrawal:
 *    the sign is redundant with `type` (the common case, and the one probe 2
 *    produced), or the sign contradicts `type` and the model meant the other
 *    direction. Nothing in the reply distinguishes them.
 *  - So: keep the declared `type`, correct the magnitude, and raise an
 *    `error`-severity warning naming the row. `error` blocks compute in the
 *    review table, so a human must look at that one row against the statement
 *    before any arithmetic runs. A silent wrong number becomes a hard gate on
 *    one cell — which is the outcome this package prefers everywhere else too.
 *
 * BALANCES ARE DELIBERATELY NOT TOUCHED. A negative account value is not a
 * sign-convention slip; it is either meaningless or a real margin debit, and
 * either way flipping it invents a number. `crossCheck` reports it as
 * `non-positive-balance` at `error` severity and leaves it alone.
 *
 * EXCLUSIONS ARE CORRECTED AT `warning` SEVERITY, not `error`. They never reach
 * the maths — nothing in `excluded` is summed into anything the engine sees —
 * so a sign slip there is a display problem, not a wrong answer.
 *
 * Never mutates its input. `outcome.raw` still holds exactly what came back.
 */
export function normaliseAmounts(result: ExtractionResult): {
  result: ExtractionResult;
  corrections: AmountCorrection[];
  warnings: ExtractionWarning[];
} {
  const corrections: AmountCorrection[] = [];
  const warnings: ExtractionWarning[] = [];

  // `< 0` and not `!(x > 0)`: zero has no sign to correct and no direction to
  // be ambiguous about. It stays put and stays a `non-positive-amount` warning.
  const rows: ExtractedRow[] = result.rows.map((row, index) => {
    if (row.type === 'balance' || !(row.amount < 0)) return row;
    const to = Math.abs(row.amount);
    const path = `rows[${index}]`;
    corrections.push({ path, where: 'rows', index, type: row.type, from: row.amount, to });
    warnings.push({
      code: 'negative-amount',
      severity: 'error',
      message: `${row.date}: this ${row.type} came back as ${row.amount}. Amounts carry no sign — direction comes from the type — so it is shown as ${to}. Check the statement and confirm the direction before continuing.`,
      path,
    });
    return { ...row, amount: to };
  });

  const excluded: ExcludedEntry[] = result.excluded.map((entry, index) => {
    if (!(entry.amount < 0)) return entry;
    const to = Math.abs(entry.amount);
    const path = `excluded[${index}]`;
    corrections.push({
      path,
      where: 'excluded',
      index,
      type: entry.type,
      from: entry.amount,
      to,
    });
    warnings.push({
      code: 'negative-amount',
      severity: 'warning',
      message: `${entry.date}: this excluded ${entry.type} came back as ${entry.amount} and is shown as ${to}. It is excluded either way, so nothing is computed from it.`,
      path,
    });
    return { ...entry, amount: to };
  });

  if (corrections.length === 0) return { result, corrections, warnings };
  return { result: { ...result, rows, excluded }, corrections, warnings };
}

/** Recompute every figure the model reports in `summary`, from its own rows. */
export function recomputeSummary(result: ExtractionResult): RecomputedSummary {
  const rows = result.rows;
  const sum = (t: string) =>
    round2(rows.filter((r) => r.type === t).reduce((a, r) => a + r.amount, 0));
  const totalContributed = sum('contribution');
  const totalWithdrawn = sum('withdrawal');
  const dates = rows.map((r) => r.date).sort();
  const accounts = [
    ...new Set(
      [...rows, ...result.excluded].map((r) => r.account).filter((a) => a !== ''),
    ),
  ].sort();
  const currencies = [
    ...new Set([...rows, ...result.excluded].map((r) => r.currency)),
  ].sort();

  return {
    totalContributed,
    totalWithdrawn,
    netInvested: round2(totalContributed - totalWithdrawn),
    rowCount: rows.length,
    balanceCount: rows.filter((r) => r.type === 'balance').length,
    contributionCount: rows.filter((r) => r.type === 'contribution').length,
    withdrawalCount: rows.filter((r) => r.type === 'withdrawal').length,
    transfersExcluded: result.excluded.filter((e) => e.reason === 'internal-transfer')
      .length,
    datesInferred: rows.filter((r) => r.dateConfidence === 'inferred').length,
    amountsNotReadDirectly: rows.filter((r) => r.amountConfidence !== 'read').length,
    accounts,
    currencies,
    firstDate: dates.length ? dates[0] : null,
    lastDate: dates.length ? dates[dates.length - 1] : null,
  };
}

/** Tolerance on the model's stated money totals, in currency units. */
const MONEY_TOLERANCE = 0.01;

/**
 * Everything worth telling the user about a structurally valid extraction.
 *
 * `now` is passed explicitly rather than read from the clock, for the same
 * reason `PortfolioInput.now` is: a check that flips at midnight makes the
 * whole call irreproducible and its tests flaky.
 */
export function crossCheck(
  result: ExtractionResult,
  now: Date = new Date(),
): { warnings: ExtractionWarning[]; recomputed: RecomputedSummary } {
  const warnings: ExtractionWarning[] = [];
  const recomputed = recomputeSummary(result);
  const push = (
    code: WarningCode,
    severity: ExtractionWarning['severity'],
    message: string,
    path?: string,
  ) => warnings.push({ code, severity, message, path });

  if (result.schemaVersion !== SCHEMA_VERSION) {
    push(
      'schema-version-mismatch',
      'warning',
      `The reply declares schema version ${result.schemaVersion}; this build expects ${SCHEMA_VERSION}.`,
    );
  }

  if (result.rows.length === 0) {
    push(
      'no-rows',
      'error',
      'No rows could be read from these documents. Nothing was extracted.',
    );
  } else if (recomputed.balanceCount < 2) {
    push(
      'too-few-balances',
      'error',
      `Only ${recomputed.balanceCount} balance row${recomputed.balanceCount === 1 ? '' : 's'} was found. Two are needed — a starting and an ending value.`,
    );
  }

  const today = new Date(
    Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()),
  )
    .toISOString()
    .slice(0, 10);

  const seen = new Map<string, number>();
  result.rows.forEach((row, i) => {
    const path = `rows[${i}]`;
    if (!(row.amount > 0)) {
      if (row.type === 'balance') {
        push(
          'non-positive-balance',
          'error',
          `${row.date}: a balance of ${row.amount} cannot be analysed — the engine takes it as given.`,
          path,
        );
      } else {
        push(
          'non-positive-amount',
          'warning',
          `${row.date}: a ${row.type} of ${row.amount} has no effect and is probably an extraction error.`,
          path,
        );
      }
    }
    if (row.date > today) {
      push('future-date', 'error', `${row.date} is in the future.`, path);
    }
    if (row.currency === 'UNKNOWN') {
      push(
        'unknown-currency',
        'info',
        `${row.date}: the currency was not stated on the document.`,
        path,
      );
    }
    const key = `${row.date}|${row.type}|${row.amount}`;
    const prev = seen.get(key);
    if (prev !== undefined) {
      push(
        'duplicate-row',
        'warning',
        `${row.date} ${row.type} ${row.amount} appears twice (rows ${prev} and ${i}). It may be one transaction read from two documents.`,
        path,
      );
    } else {
      seen.set(key, i);
    }
  });

  const realCurrencies = recomputed.currencies.filter((c) => c !== 'UNKNOWN');
  if (realCurrencies.length > 1) {
    push(
      'mixed-currency',
      'error',
      `These documents mix ${realCurrencies.join(', ')}. The figures cannot be added together without a conversion the tool does not have.`,
    );
  }

  result.excluded.forEach((entry, i) => {
    if (entry.reason === 'internal-transfer' && entry.pairedWith === '') {
      push(
        'unmatched-transfer-leg',
        'warning',
        `${entry.date} ${entry.amount} was excluded as an internal transfer but its matching leg was not found. Check whether it was real money entering or leaving.`,
        `excluded[${i}]`,
      );
    }
  });

  if (result.unreadable.length > 0) {
    push(
      'unreadable-content',
      'warning',
      `${result.unreadable.length} thing${result.unreadable.length === 1 ? '' : 's'} could not be read. See the list below the table.`,
    );
  }

  if (
    result.holdings &&
    recomputed.firstDate &&
    recomputed.lastDate &&
    (result.holdings.asOf < recomputed.firstDate ||
      result.holdings.asOf > recomputed.lastDate)
  ) {
    push(
      'holdings-asof-outside-history',
      'warning',
      `The holdings snapshot is dated ${result.holdings.asOf}, outside the ${recomputed.firstDate}–${recomputed.lastDate} history. It anchors the market-weight comparison, so check the date.`,
    );
  }

  // The summary cross-check. Deliberately last: it is the loudest one, and it
  // is the only warning that says something about the model rather than the
  // documents.
  const money: (keyof RecomputedSummary)[] = [
    'totalContributed',
    'totalWithdrawn',
    'netInvested',
  ];
  const counts: (keyof RecomputedSummary)[] = [
    'rowCount',
    'balanceCount',
    'contributionCount',
    'withdrawalCount',
    'transfersExcluded',
    'datesInferred',
    'amountsNotReadDirectly',
  ];
  const disagreements: string[] = [];
  for (const field of money) {
    const stated = result.summary[field] as number;
    const actual = recomputed[field] as number;
    // Round the DIFFERENCE, not the operands: 13000.01 - 13000 is
    // 0.010000000000218 in binary floating point, and a bare `> 0.01` would
    // report a disagreement the user cannot see and cannot fix.
    if (typeof stated !== 'number' || round2(Math.abs(stated - actual)) > MONEY_TOLERANCE) {
      disagreements.push(`${field}: said ${stated}, rows give ${actual}`);
    }
  }
  for (const field of counts) {
    const stated = result.summary[field] as number;
    const actual = recomputed[field] as number;
    if (stated !== actual) {
      disagreements.push(`${field}: said ${stated}, rows give ${actual}`);
    }
  }
  if (result.summary.firstDate !== recomputed.firstDate) {
    disagreements.push(
      `firstDate: said ${result.summary.firstDate}, rows give ${recomputed.firstDate}`,
    );
  }
  if (result.summary.lastDate !== recomputed.lastDate) {
    disagreements.push(
      `lastDate: said ${result.summary.lastDate}, rows give ${recomputed.lastDate}`,
    );
  }
  if (disagreements.length > 0) {
    push(
      'summary-mismatch',
      'warning',
      `Claude's own totals do not match the rows it produced — check the table. ${disagreements.join('; ')}.`,
    );
  }

  return { warnings, recomputed };
}

/* ─────────────────────────────────────────────────── engine hand-off */

/**
 * Strip an extracted row down to what `analyse` takes.
 *
 * `amountConfidence`, `source`, `account` and the rest are UI-layer fields the
 * engine ignores; they are removed on the way in and preserved on the way out
 * to the JSON export, which is what makes a re-import show the same
 * struck-through transfers and the same estimated markers the user last saw.
 *
 * Nothing here validates. This runs on rows that have already been through the
 * review table, and the table is the only thing standing between a typo and a
 * plausible wrong number.
 */
export function toInputRows(rows: ExtractedRow[]): InputRowLike[] {
  return rows.map((r) => ({ date: r.date, type: r.type, amount: r.amount }));
}

/** Re-exported so a consumer can render the legends without importing schema. */
export const ENUMS = {
  ROW_TYPES,
  AMOUNT_CONFIDENCE,
  DATE_CONFIDENCE,
  EXCLUSION_REASONS,
} as const;
