/**
 * The extraction contract.
 *
 * One JSON Schema, used twice: sent to the API as `output_config.format` to
 * shape generation, and run against the reply client-side to prove the shape
 * held. Those two uses are NOT redundant. `output_config` is measured to change
 * what the model writes (paired A/B, 2026-08-19: bare JSON 3/3 with the schema,
 * 0/3 without) but it is not a guarantee — it does not survive
 * `stop_reason: "max_tokens"`, and the proxy silently serves
 * `claude-sonnet-4-6`, which is not on the documented structured-outputs
 * support list. Enforcement here is a strong prior, not a proof. See README.md.
 *
 * DESIGN RULE: constrain everything the schema language can express, and hand
 * everything it cannot to `validate.ts`. `additionalProperties: false` on every
 * object; `enum` for every closed set; `format: "date"` for every date; every
 * property in `required`, with nullability expressed as an explicit
 * `anyOf [..., {type: "null"}]` rather than by omission. A missing key and a
 * key that is deliberately empty are different facts, and a schema that permits
 * both cannot tell the review table which it got.
 *
 * WHAT IS DELIBERATELY ABSENT. `minimum`, `maximum`, `minLength`, `maxLength`,
 * `pattern` and `multipleOf` are not supported by the API's schema subset and
 * are silently dropped rather than rejected — putting them here would produce a
 * schema that reads as if it validates ranges and does not. Amount positivity,
 * calendar-date validity (`2025-02-30` satisfies `format: "date"` shape-wise
 * but is not a day) and every cross-field check live in `validate.ts` instead,
 * where they actually run.
 */

/** Bumped when the shape changes in a way a stored extraction cannot survive. */
export const SCHEMA_VERSION = 1;

/* ────────────────────────────────────────────────────────── enumerations */

/**
 * The only three row types the engine understands. Synonyms — deposit, buy,
 * distribution, ending value, market value — are a PARSER concern and never
 * appear here; the model emits canonical values or nothing.
 */
export const ROW_TYPES = ['balance', 'contribution', 'withdrawal'] as const;
export type RowType = (typeof ROW_TYPES)[number];

/**
 * How the model came by an amount.
 *
 * - `read`      — the number is printed on the document.
 * - `derived`   — computed from other printed numbers by arithmetic the model
 *                 can show (differencing a year-to-date column across two
 *                 statements, summing four quarterly totals). Not a guess, and
 *                 not a reading either; the quarterly-reconstruction case has
 *                 nowhere else to live.
 * - `estimated` — a judgement call. The review table renders these with a
 *                 distinct style and a legend, per INTERACTION.md.
 *
 * There is deliberately no fourth value for "guessed". A number the model
 * cannot read, derive or defensibly estimate does not become a row; it becomes
 * an `unreadable` entry.
 */
export const AMOUNT_CONFIDENCE = ['read', 'derived', 'estimated'] as const;
export type AmountConfidence = (typeof AMOUNT_CONFIDENCE)[number];

/**
 * How the model came by a DATE, tracked separately from the amount.
 *
 * They separate constantly in real statements: a quarterly summary prints an
 * exact figure ("Contributions this quarter: 3,000.00") against no transaction
 * date at all. The amount is `read`; the date is `inferred`. Collapsing the two
 * into one confidence field would either overstate the amount or understate the
 * date, and the date is the one that silently breaks the maths — a flow placed
 * in the wrong month moves the reference's return on money that was not yet
 * invested.
 */
export const DATE_CONFIDENCE = ['read', 'inferred'] as const;
export type DateConfidence = (typeof DATE_CONFIDENCE)[number];

/**
 * Why a line the document shows is NOT in `rows`.
 *
 * Every one of these is a way to overstate money-in or money-out, and each has
 * produced a real error. `internal-transfer` is the $11,375 misstatement in the
 * original analysis. `dividend`, `interest` and `capital-gains-distribution`
 * are returns the account already earned — counting them as contributions makes
 * a portfolio look like it was fed money it generated itself. `fee-in-account`
 * is already inside the reported balance; counting it as a withdrawal inflates
 * the measured return by the fee twice over.
 */
export const EXCLUSION_REASONS = [
  'internal-transfer',
  'dividend',
  'interest',
  'capital-gains-distribution',
  'reinvestment',
  'fee-in-account',
  'tax-withheld-in-account',
  'in-kind-transfer',
  'corporate-action',
  'reversed-or-corrected',
  'pending-or-unsettled',
  'duplicate',
  'already-inside-a-balance',
  'other',
] as const;
export type ExclusionReason = (typeof EXCLUSION_REASONS)[number];

/* ─────────────────────────────────────────────────────── result types */

/** One extracted row, plus the provenance the review table renders. */
export interface ExtractedRow {
  /** ISO `YYYY-MM-DD`, zero-padded. */
  date: string;
  type: RowType;
  /** Positive. Sign is carried by `type`, never by the number. */
  amount: number;
  /** ISO 4217, uppercase. `"UNKNOWN"` when the document never says. */
  currency: string;
  amountConfidence: AmountConfidence;
  dateConfidence: DateConfidence;
  /** The account this came from, as the document names it. `""` if unnamed. */
  account: string;
  /** Where to look to check it: `"Q3 statement p2, Ending Value"`. */
  source: string;
  /** Why it is `derived` or `estimated`, or what is odd about it. `""` if not. */
  note: string;
}

/** A line the document shows that deliberately did not become a row. */
export interface ExcludedEntry {
  date: string;
  /** What the document called it, in canonical terms. */
  type: RowType;
  amount: number;
  currency: string;
  reason: ExclusionReason;
  /**
   * For `internal-transfer`, the other leg in plain words:
   * `"2026-02-15 withdrawal 7500.00 from Brokerage ...4412"`. `""` otherwise,
   * or when the model excluded one leg without finding its partner — which is
   * itself worth surfacing.
   */
  pairedWith: string;
  account: string;
  source: string;
  note: string;
}

/** Something the model could not read. Never a guess; always a location. */
export interface UnreadableItem {
  /** `"Q3 statement p4"`, `"screenshot 2"`, `"row 61 of activity.csv"`. */
  location: string;
  /** What is missing or illegible, in one line. */
  description: string;
}

export interface ExtractedHolding {
  ticker: string;
  value: number;
  account: string;
}

/** Tier-3 positions snapshot. Sits beside rows, never inside them. */
export interface ExtractedHoldings {
  /** `YYYY-MM-DD`. Load-bearing: it anchors the market-weight comparison. */
  asOf: string;
  positions: ExtractedHolding[];
}

/**
 * The model's own account of what it did.
 *
 * DISPLAY-ONLY AND NEVER TRUSTED. Every figure here is recomputed from `rows`
 * and `excluded` by `validate.ts`. When the model's totals disagree with the
 * model's own rows, that is a red banner and a free, deterministic catch on a
 * whole class of extraction error the schema cannot see. It exists because
 * INTERACTION.md requires the user be shown what was found, excluded and
 * guessed at — as structured data, so the table can render it, not as a
 * paragraph the table has to trust.
 */
export interface ExtractionSummary {
  totalContributed: number;
  totalWithdrawn: number;
  /** `totalContributed - totalWithdrawn`. */
  netInvested: number;
  rowCount: number;
  balanceCount: number;
  contributionCount: number;
  withdrawalCount: number;
  /** Entries in `excluded` whose reason is `internal-transfer`. */
  transfersExcluded: number;
  /** Rows whose `dateConfidence` is `inferred`. */
  datesInferred: number;
  /** Rows whose `amountConfidence` is `derived` or `estimated`. */
  amountsNotReadDirectly: number;
  /** Distinct account names seen, combined into one set of rows. */
  accounts: string[];
  /** Distinct currencies seen. More than one is a hard stop for the table. */
  currencies: string[];
  /** Earliest and latest row date, or null when there are no rows. */
  firstDate: string | null;
  lastDate: string | null;
}

/** The whole contract. What `output_config.format` asks for and what returns. */
export interface ExtractionResult {
  schemaVersion: number;
  rows: ExtractedRow[];
  excluded: ExcludedEntry[];
  holdings: ExtractedHoldings | null;
  summary: ExtractionSummary;
  unreadable: UnreadableItem[];
  /**
   * Anything that did not reconcile, in one line each: a balance that does not
   * follow from the prior balance plus flows, an account whose statements skip
   * a quarter, a total the document states that its own lines do not sum to.
   * Prose, but bounded and additive — nothing downstream parses it.
   */
  notes: string[];
}

/* ─────────────────────────────────────────────────── the schema itself */

const str = (description: string) => ({ type: 'string', description } as const);
const num = (description: string) => ({ type: 'number', description } as const);
const int = (description: string) => ({ type: 'integer', description } as const);

const dateString = (description: string) =>
  ({ type: 'string', format: 'date', description } as const);

const nullableDate = (description: string) =>
  ({
    description,
    anyOf: [{ type: 'string', format: 'date' }, { type: 'null' }],
  }) as const;

const rowSchema = {
  type: 'object',
  additionalProperties: false,
  required: [
    'date',
    'type',
    'amount',
    'currency',
    'amountConfidence',
    'dateConfidence',
    'account',
    'source',
    'note',
  ],
  properties: {
    date: dateString('The date this applies to, ISO YYYY-MM-DD, zero-padded.'),
    type: {
      type: 'string',
      enum: ROW_TYPES,
      description:
        'balance = total account value on that date. contribution = new money entering from outside the accounts being analysed. withdrawal = money leaving them for good.',
    },
    amount: num(
      'A positive number. No currency symbol, no thousands separators. Direction is carried by type, never by the sign.',
    ),
    currency: str(
      'ISO 4217 code, uppercase, e.g. USD, GBP, EUR. Use "UNKNOWN" if the document never states it — do not assume.',
    ),
    amountConfidence: {
      type: 'string',
      enum: AMOUNT_CONFIDENCE,
      description:
        'read = the number is printed. derived = computed by arithmetic from printed numbers (differencing YTD columns, summing quarters). estimated = a judgement call. Never invent a number you cannot place in one of these three.',
    },
    dateConfidence: {
      type: 'string',
      enum: DATE_CONFIDENCE,
      description:
        'read = the date is printed against this figure. inferred = you placed it yourself (e.g. a quarterly total assigned to the quarter end).',
    },
    account: str(
      'The account this came from, named as the document names it. Empty string if the document names only one account or none.',
    ),
    source: str(
      'Where a person should look to check this figure: "Q3 statement p2, Ending Value". Never empty.',
    ),
    note: str(
      'Why this is derived or estimated, or anything odd about it. Empty string if there is nothing to say.',
    ),
  },
} as const;

const excludedSchema = {
  type: 'object',
  additionalProperties: false,
  required: [
    'date',
    'type',
    'amount',
    'currency',
    'reason',
    'pairedWith',
    'account',
    'source',
    'note',
  ],
  properties: {
    date: dateString('The date of the line you excluded.'),
    type: {
      type: 'string',
      enum: ROW_TYPES,
      description: 'What the excluded line would have been, had you kept it.',
    },
    amount: num('Positive number, as above.'),
    currency: str('ISO 4217 code, or "UNKNOWN".'),
    reason: {
      type: 'string',
      enum: EXCLUSION_REASONS,
      description:
        'Why this is not real money entering or leaving. internal-transfer is money moving between accounts the user owns.',
    },
    pairedWith: str(
      'For an internal transfer, the matching leg in plain words: "2026-02-15 withdrawal 7500.00 from Brokerage ...4412". Empty string if there is no pair, including when you excluded one leg WITHOUT finding its partner — say so in note if so.',
    ),
    account: str('Account the line appeared on, or empty string.'),
    source: str('Where to find it in the document. Never empty.'),
    note: str('One line on why, if the reason code does not say enough.'),
  },
} as const;

const unreadableSchema = {
  type: 'object',
  additionalProperties: false,
  required: ['location', 'description'],
  properties: {
    location: str(
      'Where the unreadable thing is: "Q3 statement p4", "screenshot 2", "row 61 of activity.csv".',
    ),
    description: str(
      'What is missing or illegible, in one line. This is where a number you cannot read goes — never into rows.',
    ),
  },
} as const;

const holdingsSchema = {
  type: 'object',
  additionalProperties: false,
  required: ['asOf', 'positions'],
  properties: {
    asOf: dateString(
      'The date the positions were valued. This anchors a market-weight comparison, so it must be the snapshot date, not today.',
    ),
    positions: {
      type: 'array',
      description: 'One entry per fund or stock held on that date.',
      items: {
        type: 'object',
        additionalProperties: false,
        required: ['ticker', 'value', 'account'],
        properties: {
          ticker: str(
            'The ticker as printed, uppercase. If the document gives only a fund name and no ticker, put the name here.',
          ),
          value: num('Market value of the position on asOf, positive.'),
          account: str('Account it is held in, or empty string.'),
        },
      },
    },
  },
} as const;

const summarySchema = {
  type: 'object',
  additionalProperties: false,
  description:
    'Your own account of what you did. Every figure here is recomputed from rows and excluded and compared against what you say; a disagreement is shown to the user as a warning, so state what you actually produced rather than what you intended.',
  required: [
    'totalContributed',
    'totalWithdrawn',
    'netInvested',
    'rowCount',
    'balanceCount',
    'contributionCount',
    'withdrawalCount',
    'transfersExcluded',
    'datesInferred',
    'amountsNotReadDirectly',
    'accounts',
    'currencies',
    'firstDate',
    'lastDate',
  ],
  properties: {
    totalContributed: num('Sum of every contribution row in rows.'),
    totalWithdrawn: num('Sum of every withdrawal row in rows.'),
    netInvested: num('totalContributed minus totalWithdrawn. May be negative.'),
    rowCount: int('Number of entries in rows.'),
    balanceCount: int('Number of rows whose type is balance.'),
    contributionCount: int('Number of rows whose type is contribution.'),
    withdrawalCount: int('Number of rows whose type is withdrawal.'),
    transfersExcluded: int(
      'Number of entries in excluded whose reason is internal-transfer.',
    ),
    datesInferred: int('Number of rows whose dateConfidence is inferred.'),
    amountsNotReadDirectly: int(
      'Number of rows whose amountConfidence is derived or estimated.',
    ),
    accounts: {
      type: 'array',
      description:
        'Every distinct account name you combined, in the words the documents use. Empty array if there is only one unnamed account.',
      items: { type: 'string' },
    },
    currencies: {
      type: 'array',
      description:
        'Every distinct currency you saw, ISO 4217. More than one entry means the figures cannot be added together, so list them honestly.',
      items: { type: 'string' },
    },
    firstDate: nullableDate('Earliest date in rows, or null if rows is empty.'),
    lastDate: nullableDate('Latest date in rows, or null if rows is empty.'),
  },
} as const;

/**
 * The schema handed to `output_config.format`.
 *
 * Kept as a plain frozen object rather than generated, because it is a wire
 * contract: it is easier to review a literal than to review the function that
 * would have produced it, and the descriptions inside it are half the prompt.
 */
export const EXTRACTION_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  description:
    'The complete result of reading a set of investment account documents into an analysable history.',
  required: [
    'schemaVersion',
    'rows',
    'excluded',
    'holdings',
    'summary',
    'unreadable',
    'notes',
  ],
  properties: {
    schemaVersion: {
      type: 'integer',
      const: SCHEMA_VERSION,
      description: `Always ${SCHEMA_VERSION}.`,
    },
    rows: {
      type: 'array',
      description:
        'The account history, one entry per balance, contribution or withdrawal. Order does not matter. Empty array is a valid answer when nothing could be read — say why in unreadable.',
      items: rowSchema,
    },
    excluded: {
      type: 'array',
      description:
        'Every line you deliberately did NOT turn into a row, with the reason. Internal transfers especially. Empty array if you excluded nothing.',
      items: excludedSchema,
    },
    holdings: {
      description:
        'The positions snapshot, if the documents contain a holdings or positions page. null if they do not.',
      anyOf: [holdingsSchema, { type: 'null' }],
    },
    summary: summarySchema,
    unreadable: {
      type: 'array',
      description:
        'Everything you could not read. This is the only correct destination for a figure you cannot determine.',
      items: unreadableSchema,
    },
    notes: {
      type: 'array',
      description:
        'Anything that did not reconcile, one line each: a balance that does not follow from the prior balance plus flows, a missing statement period, a stated total its own lines do not sum to. Empty array if everything reconciled.',
      items: { type: 'string' },
    },
  },
} as const;

/**
 * The schema as an ordinary mutable JSON value, for `JSON.stringify` into a
 * request body without TypeScript's `as const` readonly types leaking out.
 */
export function extractionSchema(): Record<string, unknown> {
  return JSON.parse(JSON.stringify(EXTRACTION_SCHEMA)) as Record<string, unknown>;
}
