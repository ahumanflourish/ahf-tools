/**
 * Hand-written extraction results.
 *
 * Written by hand, not captured from a model, and that is the point: the schema
 * has to be tested against what a careless model WOULD produce, not against
 * what a careful one did. Every invalid case below is a specific way real
 * output goes wrong — a synonym that leaked past the enum, a date that is
 * shaped right and is not a day, an extra field bolted on, a required field
 * quietly dropped.
 *
 * The valid fixture doubles as the worked example for the whole flow: two
 * accounts, a reconstructed quarterly flow, an inferred date, a fee that is not
 * a withdrawal, and a genuine internal transfer with both legs excluded.
 */

import type { ExtractionResult } from '../src/types';

/** Deep clone, so a test that mutates a fixture cannot poison the next one. */
export const clone = <T>(v: T): T => JSON.parse(JSON.stringify(v)) as T;

export const VALID: ExtractionResult = {
  schemaVersion: 1,
  rows: [
    {
      date: '2021-10-12',
      type: 'contribution',
      amount: 10000,
      currency: 'USD',
      amountConfidence: 'read',
      dateConfidence: 'read',
      account: 'Brokerage ...4412',
      source: 'Q4 2021 statement p2, Activity',
      note: '',
    },
    {
      date: '2021-12-31',
      type: 'balance',
      amount: 16500.81,
      currency: 'USD',
      amountConfidence: 'read',
      dateConfidence: 'read',
      account: 'Brokerage ...4412',
      source: 'Q4 2021 statement p1, Ending Value',
      note: '',
    },
    {
      date: '2022-12-31',
      type: 'balance',
      amount: 13412.47,
      currency: 'USD',
      amountConfidence: 'read',
      dateConfidence: 'read',
      account: 'Brokerage ...4412',
      source: 'Q4 2022 statement p1, Ending Value',
      note: '',
    },
    {
      date: '2023-03-31',
      type: 'contribution',
      amount: 3000,
      currency: 'USD',
      amountConfidence: 'derived',
      dateConfidence: 'inferred',
      account: 'IRA ...9087',
      source: 'Q1 2023 statement p1, Contributions YTD',
      note: 'YTD 3,000 at Q1 less YTD 0 at year start; placed at quarter end.',
    },
    {
      date: '2023-12-29',
      type: 'balance',
      amount: 19602.4,
      currency: 'USD',
      amountConfidence: 'read',
      dateConfidence: 'read',
      account: 'Brokerage ...4412',
      source: 'Q4 2023 statement p1, Ending Value',
      note: '',
    },
  ],
  excluded: [
    {
      date: '2026-02-15',
      type: 'contribution',
      amount: 7500,
      currency: 'USD',
      reason: 'internal-transfer',
      pairedWith: '2026-02-15 withdrawal 7500.00 from Brokerage ...4412',
      account: 'IRA ...9087',
      source: 'Feb 2026 statement p3',
      note: '',
    },
    {
      date: '2026-02-15',
      type: 'withdrawal',
      amount: 7500,
      currency: 'USD',
      reason: 'internal-transfer',
      pairedWith: '2026-02-15 contribution 7500.00 into IRA ...9087',
      account: 'Brokerage ...4412',
      source: 'Feb 2026 statement p3',
      note: '',
    },
    {
      date: '2023-06-30',
      type: 'withdrawal',
      amount: 42.13,
      currency: 'USD',
      reason: 'fee-in-account',
      pairedWith: '',
      account: 'Brokerage ...4412',
      source: 'Q2 2023 statement p2, Fees',
      note: 'Already inside the reported balance; not money leaving the account.',
    },
  ],
  holdings: {
    asOf: '2023-08-31',
    positions: [
      { ticker: 'VTI', value: 3295.35, account: 'Brokerage ...4412' },
      { ticker: 'IEFA', value: 2877.13, account: 'Brokerage ...4412' },
    ],
  },
  summary: {
    totalContributed: 13000,
    totalWithdrawn: 0,
    netInvested: 13000,
    rowCount: 5,
    balanceCount: 3,
    contributionCount: 2,
    withdrawalCount: 0,
    transfersExcluded: 2,
    datesInferred: 1,
    amountsNotReadDirectly: 1,
    accounts: ['Brokerage ...4412', 'IRA ...9087'],
    currencies: ['USD'],
    firstDate: '2021-10-12',
    lastDate: '2023-12-29',
  },
  unreadable: [
    {
      location: 'Q3 2022 statement p1',
      description: 'The ending value is obscured by a scanning artefact.',
    },
  ],
  notes: [
    'The 2022 year-end balance is for the brokerage account only; the IRA statements begin in 2023.',
  ],
};

/** Zero rows and a full unreadable list — a correct answer, not a failure. */
export const VALID_EMPTY: ExtractionResult = {
  schemaVersion: 1,
  rows: [],
  excluded: [],
  holdings: null,
  summary: {
    totalContributed: 0,
    totalWithdrawn: 0,
    netInvested: 0,
    rowCount: 0,
    balanceCount: 0,
    contributionCount: 0,
    withdrawalCount: 0,
    transfersExcluded: 0,
    datesInferred: 0,
    amountsNotReadDirectly: 0,
    accounts: [],
    currencies: [],
    firstDate: null,
    lastDate: null,
  },
  unreadable: [
    { location: 'screenshot 1', description: 'Too blurred to read any figure.' },
  ],
  notes: [],
};

/**
 * The deliberately invalid cases, each named for the real-world mistake it
 * stands in for. `mutate` is applied to a clone of `VALID`.
 */
export interface InvalidCase {
  name: string;
  /** Substring the reported issue path must contain. */
  path: string;
  code: string;
  mutate: (r: Record<string, any>) => void;
}

export const INVALID_CASES: InvalidCase[] = [
  {
    name: 'a type synonym that should have been normalised by the parser',
    path: 'rows[0].type',
    code: 'not-in-enum',
    mutate: (r) => {
      r.rows[0].type = 'deposit';
    },
  },
  {
    name: 'a confidence value the legend has no style for',
    path: 'rows[0].amountConfidence',
    code: 'not-in-enum',
    mutate: (r) => {
      r.rows[0].amountConfidence = 'high';
    },
  },
  {
    name: 'an exclusion reason invented on the spot',
    path: 'excluded[0].reason',
    code: 'not-in-enum',
    mutate: (r) => {
      r.excluded[0].reason = 'moved money around';
    },
  },
  {
    name: 'a date that is shaped like a date and is not a day',
    path: 'rows[1].date',
    code: 'not-a-date',
    mutate: (r) => {
      r.rows[1].date = '2025-02-30';
    },
  },
  {
    name: 'a date that is not zero-padded',
    path: 'rows[1].date',
    code: 'not-a-date',
    mutate: (r) => {
      r.rows[1].date = '2024-1-5';
    },
  },
  {
    name: 'a date written the American way',
    path: 'rows[1].date',
    code: 'not-a-date',
    mutate: (r) => {
      r.rows[1].date = '12/31/2022';
    },
  },
  {
    name: 'a required row field dropped',
    path: 'rows[2].source',
    code: 'missing-property',
    mutate: (r) => {
      delete r.rows[2].source;
    },
  },
  {
    name: 'a helpful extra field the table would silently ignore',
    path: 'rows[0].runningTotal',
    code: 'unexpected-property',
    mutate: (r) => {
      r.rows[0].runningTotal = 10000;
    },
  },
  {
    name: 'an amount returned as a formatted string',
    path: 'rows[0].amount',
    code: 'wrong-type',
    mutate: (r) => {
      r.rows[0].amount = '10,000.00';
    },
  },
  {
    name: 'a count returned as a decimal',
    path: 'summary.balanceCount',
    code: 'not-an-integer',
    mutate: (r) => {
      r.summary.balanceCount = 2.5;
    },
  },
  {
    name: 'a top-level section omitted',
    path: 'excluded',
    code: 'missing-property',
    mutate: (r) => {
      delete r.excluded;
    },
  },
  {
    name: 'holdings returned as an empty string instead of null',
    path: 'holdings',
    code: 'no-matching-variant',
    mutate: (r) => {
      r.holdings = '';
    },
  },
  {
    name: 'a nullable date returned as the string "null"',
    path: 'summary.firstDate',
    code: 'not-a-date',
    mutate: (r) => {
      r.summary.firstDate = 'null';
    },
  },
  {
    name: 'the schema version marker missing — the enforcement canary',
    path: 'schemaVersion',
    code: 'missing-property',
    mutate: (r) => {
      delete r.schemaVersion;
    },
  },
  {
    name: 'the schema version marker wrong',
    path: 'schemaVersion',
    code: 'wrong-const',
    mutate: (r) => {
      r.schemaVersion = 2;
    },
  },
  {
    name: 'notes returned as one string instead of a list',
    path: 'notes',
    code: 'wrong-type',
    mutate: (r) => {
      r.notes = 'everything reconciled';
    },
  },
  {
    name: 'an unreadable entry given as a bare string',
    path: 'unreadable[0]',
    code: 'wrong-type',
    mutate: (r) => {
      r.unreadable[0] = 'p4 was blurry';
    },
  },
  {
    name: 'a holdings position missing its account',
    path: 'holdings.positions[1].account',
    code: 'missing-property',
    mutate: (r) => {
      delete r.holdings.positions[1].account;
    },
  },
];

/** A well-formed API response envelope wrapping a given result. */
export function messageEnvelope(
  result: unknown,
  overrides: Record<string, unknown> = {},
): Record<string, unknown> {
  return {
    id: 'msg_test',
    type: 'message',
    role: 'assistant',
    model: 'claude-sonnet-4-6',
    stop_reason: 'end_turn',
    stop_sequence: null,
    content: [{ type: 'text', text: JSON.stringify(result) }],
    usage: { input_tokens: 4179, output_tokens: 812 },
    ...overrides,
  };
}
