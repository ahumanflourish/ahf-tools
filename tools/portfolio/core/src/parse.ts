/**
 * CSV / pasted-text row parser.
 *
 * Pure. No DOM, no network, no Node APIs, no wall clock. Never throws on bad
 * input: a parse failure is an expected outcome to be REPORTED, and a parser
 * that throws forces every caller to invent its own error copy.
 *
 * WHAT THIS IS FOR. Path B (paste or upload a CSV) and the landing surface for
 * Path C (Claude reads the statements). Neither hands over a clean file. A
 * model's answer arrives wrapped in a markdown fence with "Here's your data:"
 * in front of it and a summary paragraph behind it; a brokerage export arrives
 * with a BOM, CRLF line endings, eight columns in an order nobody chose, and
 * amounts quoted because they contain thousands separators. INTERACTION.md:
 * "A strict parser fails on essentially every real paste."
 *
 * THE GUARD THAT DID NOT EXIST ANYWHERE. `engine.ts`'s `toDate` is
 * `new Date(s + 'T00:00:00Z')`, so `2024-1-5` — a perfectly ordinary thing for
 * a human or a model to write — yields `Invalid Date`, which becomes `NaN` in
 * `daysBetween` and propagates out into the results with no error raised
 * anywhere. Nothing in the engine validates a date. This parser therefore
 * NORMALISES every date it emits to strict, zero-padded, real-calendar
 * `YYYY-MM-DD`, and anything it cannot normalise goes to the skipped pile with
 * a reason. No non-canonical date leaves this function.
 *
 * AMBIGUITY IS REPORTED, NEVER GUESSED. `03/04/2024` is 3 April in most of the
 * world and 4 March in the United States, and there is no evidence in the
 * string itself. Guessing changes a contribution's date by a month, which
 * changes which calendar month `replay` credits it to, which changes the
 * answer. So when the file gives no evidence either way, `parseRows` returns
 * `outcome: 'ambiguous'` with an EMPTY `rows` array and both complete readings
 * attached for the caller to preview and choose between. Empty, not populated,
 * is deliberate: a caller that forgets to check `outcome` shows an empty table
 * and is visibly broken, rather than showing a full table of dates that are
 * silently wrong by a month. Fail loud.
 *
 * WHAT IS DELIBERATELY NOT HERE. Row-level business validation — negative
 * balances, future dates, fewer than two balance rows, balances before the
 * first flow — belongs to the review table, which owns the copy for each
 * (flow-plan §4, "Inline validation"). This module's contract is narrower and
 * therefore checkable: every row it emits is *shaped* correctly. Whether it is
 * *sensible* is the table's question.
 */
import type { InputRow } from './engine';

// ══════════════════════════════════════════════════════════════ public types

export type Delimiter = ',' | '\t' | ';' | '|';

export type DateFormatName =
  | 'YYYY-MM-DD'
  | 'YYYY/MM/DD'
  | 'MM/DD/YYYY'
  | 'DD/MM/YYYY'
  | 'YYYY-MM'
  | 'Mon YYYY'
  | 'Mon D, YYYY'
  | 'D Mon YYYY';

/**
 * A parsed row, ready for the review table.
 *
 * Intersected with `InputRow` rather than redeclared, so it stays assignable
 * to what `analyse` takes and cannot drift from it. The extra fields are
 * UI-layer provenance the engine ignores.
 */
export type ParsedRow = InputRow & {
  /** 1-based line number in the ORIGINAL text, before any stripping. */
  line: number;
  /** The line verbatim, for "show me what you read". */
  raw: string;
  /** flow-plan §6: rows land in the table with `source: "pasted CSV, line 12"`. */
  source: string;
  /**
   * Set when the input carried no day — `Mar 2024`, `2024-03` — and the date
   * was resolved to the last day of that month. The table should mark these
   * `estimated`, per INTERACTION.md's confidence marker.
   */
  dateAssumed: 'month-end' | null;
};

export type SkipReason =
  | 'too-few-fields'
  | 'no-date'
  | 'bad-date'
  | 'no-amount'
  | 'bad-amount'
  | 'no-type'
  | 'unknown-type'
  | 'fee-line'
  | 'income-line'
  | 'row-cap';

export interface SkippedLine {
  /** 1-based line number in the ORIGINAL text. */
  line: number;
  /** The line verbatim. flow-plan §6: shown and individually editable. */
  text: string;
  reason: SkipReason;
  /** User-facing prose. Render it; do not paraphrase it. */
  message: string;
}

/**
 * A line that was never a data row — narration, a markdown fence, a table
 * rule. Reported separately from `skipped` and NOT counted in the "couldn't
 * be read" figure, because telling someone that "Here's your data:" failed to
 * parse is noise that trains them to ignore the real count.
 */
export interface IgnoredLine {
  line: number;
  text: string;
  message: string;
}

export interface AmbiguityExample {
  line: number;
  text: string;
  /** The raw date token that is ambiguous, e.g. `03/04/2024`. */
  value: string;
  /** How each reading resolves it, ISO. */
  asDayFirst: string;
  asMonthFirst: string;
}

/**
 * A decision the parser refuses to make on the user's behalf.
 *
 * Every variant is blocking: `rows` is empty and `outcome` is `'ambiguous'`
 * until the caller answers. See the module comment for why.
 */
export type ParseAmbiguity =
  | {
      kind: 'day-month-order';
      /** Ready-to-render question, e.g. "03/04/2024 — 3 April or March 4?" */
      question: string;
      examples: AmbiguityExample[];
      /** How many dates in the file the answer applies to. */
      affectedRows: number;
      /**
       * Both complete readings, already parsed, so the caller can show a
       * side-by-side preview and commit with one click. Re-calling
       * `parseRows(text, { dayFirst })` produces the same arrays.
       */
      readings: { dayFirst: ParsedRow[]; monthFirst: ParsedRow[] };
      /** The option to pass back. */
      resolveWith: 'dayFirst';
    }
  | {
      kind: 'day-month-conflict';
      question: string;
      /** Lines proving day-first, and lines proving month-first. */
      dayFirstEvidence: AmbiguityExample[];
      monthFirstEvidence: AmbiguityExample[];
      /** No reading is correct; the file mixes two orderings. */
      readings: null;
      resolveWith: 'dayFirst';
    }
  | {
      kind: 'flow-direction';
      question: string;
      /** How many amounts are negative. */
      negativeCount: number;
      positiveCount: number;
      examples: { line: number; text: string; value: number }[];
      readings: { negativeIsWithdrawal: ParsedRow[] };
      resolveWith: 'assumeNegativeIsWithdrawal';
    };

export interface ParseAssumptions {
  delimiter: Delimiter;
  delimiterName: 'comma' | 'tab' | 'semicolon' | 'pipe';
  delimiterSource: 'sniffed' | 'caller' | 'default';
  lineEndings: 'LF' | 'CRLF' | 'CR' | 'mixed' | 'none';
  bomStripped: boolean;
  /** True when a markdown fence was found and only its contents were read. */
  fenced: boolean;
  columnMapping: 'by-name' | 'positional';
  /** Resolved column indices. `type` is null when the file has no type column. */
  columns: { date: number; type: number | null; amount: number };
  header: { present: boolean; line: number | null; text: string | null; names: string[] };
  /** Distinct date formats actually encountered, in the order first seen. */
  dateFormats: DateFormatName[];
  dayMonthOrder: 'DD/MM' | 'MM/DD' | null;
  dayMonthOrderSource: 'evidence' | 'caller' | 'not-needed' | 'unresolved';
  /** Count of dates carrying no day, resolved to the last day of the month. */
  monthOnlyDates: number;
  /** True when `1.234,56` was read as 1234.56 (European export). */
  decimalComma: boolean;
  /** Set when the file has no type column and every row is a balance. */
  impliedType: 'balance' | null;
  /** Set only when the caller answered the `flow-direction` question. */
  negativeIsWithdrawal: boolean | null;
}

export interface ParseStats {
  /** Lines in the original text. */
  totalLines: number;
  blankLines: number;
  ignoredLines: number;
  /** Lines that looked like data and were attempted. */
  dataLines: number;
  parsed: number;
  skipped: number;
  /** True when `maxRows` cut the file short. */
  truncated: boolean;
}

export type ParseOutcome = 'ok' | 'ambiguous' | 'empty' | 'too-large';

export interface ParseResult {
  /**
   * - `ok` — at least one row parsed and nothing needs a human decision.
   * - `ambiguous` — `rows` is EMPTY; answer `ambiguities` and re-parse.
   * - `empty` — nothing parseable. A named outcome, not an empty array:
   *   INTERACTION.md requires "show the raw input alongside the expected
   *   format rather than a generic error", and a caller cannot distinguish
   *   "no rows" from "no input" without being told which it was.
   * - `too-large` — the input exceeded `maxChars`. Nothing was parsed.
   */
  outcome: ParseOutcome;
  rows: ParsedRow[];
  /** Lines that looked like data and could not be read. Never silent. */
  skipped: SkippedLine[];
  /** `skipped.length`, hoisted because it is the number the copy quotes. */
  skippedCount: number;
  ignored: IgnoredLine[];
  ambiguities: ParseAmbiguity[];
  assumptions: ParseAssumptions;
  stats: ParseStats;
  /** flow-plan §6.11: "Read 47 rows. 3 lines couldn't be read." */
  summary: string;
}

export interface ParseOptions {
  /**
   * Answers the `day-month-order` question. `true` = `DD/MM/YYYY`.
   * Ignored when the file carries its own evidence — a file containing
   * `31/01/2024` is day-first whatever the caller believes.
   */
  dayFirst?: boolean;
  /** Answers the `flow-direction` question. */
  assumeNegativeIsWithdrawal?: boolean;
  /** Override the delimiter sniff. */
  delimiter?: Delimiter;
  /** flow-plan §6.13. Default 10,000. */
  maxRows?: number;
  /** flow-plan §6.13. Default 5,000,000 characters. */
  maxChars?: number;
  /** Prefix for `ParsedRow.source`. Default `"pasted CSV"`. */
  sourceLabel?: string;
}

// ══════════════════════════════════════════════════════════ synonym tables

/**
 * Type synonyms, per flow-plan §1.1. Matched case-insensitively after
 * whitespace / underscore / hyphen normalisation, first as a whole string and
 * then as a whole-word substring — brokerage description columns say
 * "ELECTRONIC FUNDS TRANSFER RECEIVED", not "contribution".
 *
 * Longest phrase first within each list, so `transfer in` is tested before
 * anything that could shadow it.
 */
const CONTRIBUTION_WORDS = [
  'employee contribution', 'employer contribution', 'employer match',
  'transfer in', 'rollover in', 'funds received', 'cash in',
  'contributions', 'contribution', 'rollover', 'purchased', 'purchase',
  'deposits', 'deposit', 'bought', 'buy', 'incoming',
];
const WITHDRAWAL_WORDS = [
  'transfer out', 'rollover out', 'funds withdrawn', 'cash out',
  'withdrawals', 'withdrawal', 'distributions', 'distribution',
  'redemption', 'redeemed', 'sold', 'sell', 'sale', 'outgoing',
];
const BALANCE_WORDS = [
  'ending market value', 'ending balance', 'closing balance',
  'beginning balance', 'opening balance', 'account value', 'portfolio value',
  'net asset value', 'market value', 'ending value', 'total value',
  'balance', 'value', 'nav',
];

/**
 * Types that must NEVER become a flow, each with its own message.
 *
 * A fee and a reinvested dividend are already inside the reported balance.
 * Counting the fee as a withdrawal inflates the measured return; counting the
 * dividend as a contribution overstates money in. Both are the same class of
 * error the whole tool exists to catch, so they get a specific message rather
 * than the generic "didn't recognise that type".
 */
const REJECT_WORDS: { words: string[]; reason: SkipReason; message: string }[] = [
  {
    words: ['advisory fee', 'management fee', 'account fee', 'commission', 'fees', 'fee'],
    reason: 'fee-line',
    message:
      'A fee is already inside the reported balance. Counting it as a withdrawal ' +
      'would inflate the measured return, so this line was left out.',
  },
  {
    words: [
      'qualified dividend', 'capital gains', 'capital gain', 'reinvestment',
      'reinvest', 'dividends', 'dividend', 'interest',
    ],
    reason: 'income-line',
    message:
      'A dividend, distribution of income or reinvestment is already inside the ' +
      'reported balance. Counting it as a contribution would overstate the money ' +
      'you put in, so this line was left out.',
  },
];

/** Header-name families, in priority order. First match wins. */
const DATE_HEADERS = [
  // Trade / run / activity date before settlement date: the flow happened when
  // it was instructed, and a settlement column is a day or two later.
  'date', 'trade date', 'run date', 'activity date', 'transaction date',
  'posted date', 'settlement date', 'as of date', 'as of', 'period', 'month',
];
const TYPE_HEADERS = [
  // `action` and `activity` before the bare `type`, because Fidelity's `Type`
  // column holds "Cash" / "Margin" and its `Action` column holds the
  // transaction. Getting that the wrong way round reads every row as unknown.
  'transaction type', 'activity', 'action', 'transaction', 'type',
  'description', 'category', 'event',
];
const AMOUNT_HEADERS = [
  'amount', 'net amount', 'transaction amount', 'net cash amount', 'cash amount',
  'ending value', 'ending balance', 'closing balance', 'market value',
  'account value', 'total value', 'balance', 'value',
];
/** Header names that mean the amount column is a balance, not a flow. */
const BALANCE_HEADERS = new Set([
  'ending value', 'ending balance', 'closing balance', 'market value',
  'account value', 'total value', 'balance', 'value',
]);

const MONTHS: Record<string, number> = {
  jan: 1, january: 1, feb: 2, february: 2, mar: 3, march: 3, apr: 4, april: 4,
  may: 5, jun: 6, june: 6, jul: 7, july: 7, aug: 8, august: 8,
  sep: 9, sept: 9, september: 9, oct: 10, october: 10, nov: 11, november: 11,
  dec: 12, december: 12,
};

// ══════════════════════════════════════════════════════════════ small tools

/** Lowercase, collapse `_ - /` and runs of whitespace, strip edge punctuation. */
function normaliseWord(s: string): string {
  return s
    .toLowerCase()
    .replace(/[_\-/]+/g, ' ')
    .replace(/\s+/g, ' ')
    .replace(/^[^a-z0-9]+|[^a-z0-9)]+$/g, '')
    .trim();
}

/** Header name: as above, then drop a trailing unit marker like `($)`. */
function normaliseHeader(s: string): string {
  return normaliseWord(s.replace(/\([^)]*\)/g, ' '));
}

/** Whole-word containment, so `fee` does not fire inside `coffee`. */
function hasWord(haystack: string, needle: string): boolean {
  if (haystack === needle) return true;
  const i = haystack.indexOf(needle);
  if (i < 0) return false;
  const before = i === 0 ? ' ' : haystack[i - 1];
  const after = i + needle.length >= haystack.length ? ' ' : haystack[i + needle.length];
  return !/[a-z0-9]/.test(before) && !/[a-z0-9]/.test(after);
}

function matchAny(value: string, words: string[]): boolean {
  return words.some((w) => hasWord(value, w));
}

// ══════════════════════════════════════════════════════ field-level parsing

/**
 * Split one line into fields, honouring RFC-4180 quoting.
 *
 * This is the single most valuable thing in the module and INTERACTION.md does
 * not mention it. A spreadsheet or brokerage export writes an amount above a
 * thousand as `"1,234.56"`, and a naive `line.split(',')` turns one row into
 * two fields of garbage — silently, because both halves still look numeric.
 * A doubled quote inside a quoted field is a literal quote.
 */
export function splitFields(line: string, delimiter: string): string[] {
  const out: string[] = [];
  let cur = '';
  let quoted = false;
  let i = 0;
  while (i < line.length) {
    const ch = line[i];
    if (quoted) {
      if (ch === '"') {
        if (line[i + 1] === '"') { cur += '"'; i += 2; continue; }
        quoted = false; i++; continue;
      }
      cur += ch; i++; continue;
    }
    // A quote only opens a field at its start; a stray quote mid-field is data.
    if (ch === '"' && cur.trim() === '') { quoted = true; cur = ''; i++; continue; }
    if (ch === delimiter) { out.push(cur.trim()); cur = ''; i++; continue; }
    cur += ch; i++;
  }
  out.push(cur.trim());
  return out;
}

/** Unescaped quote count, for joining a field that spans lines. */
function quoteParity(line: string): number {
  let n = 0;
  for (let i = 0; i < line.length; i++) {
    if (line[i] !== '"') continue;
    if (line[i + 1] === '"') { i++; continue; }
    n++;
  }
  return n;
}

const CURRENCY = /[$£€¥₹₽]/g;
const CURRENCY_CODE = /^(usd|gbp|eur|cad|aud|chf|jpy|nzd|sek|nok|dkk)\b|\b(usd|gbp|eur|cad|aud|chf|jpy|nzd|sek|nok|dkk)$/gi;

/**
 * Read a number out of a statement cell.
 *
 * Handles: currency symbols and ISO codes, thousands separators (`,`, spaces,
 * apostrophes), parenthesised negatives (`($3,000)` is −3000), a leading or
 * TRAILING minus (`3,000-` is how a good many mainframe-era exports write it),
 * and `CR`/`DR` suffixes. Returns null rather than NaN for anything else, so a
 * date, a percentage or a ticker can never be mistaken for an amount.
 *
 * `decimalComma` switches to the European reading: `1.234,56` is 1234.56. It
 * is applied only to strings that actually contain a comma, so a bare `1.234`
 * is never silently multiplied by a thousand.
 */
export function parseAmount(raw: string, decimalComma = false): number | null {
  let s = raw.trim();
  if (!s) return null;
  let negative = false;

  if (/^\(.*\)$/.test(s)) { negative = true; s = s.slice(1, -1).trim(); }
  s = s.replace(CURRENCY, '').replace(CURRENCY_CODE, '').trim();

  const cr = /\s*(CR|DR)$/i.exec(s);
  if (cr) { if (cr[1].toUpperCase() === 'DR') negative = true; s = s.slice(0, cr.index).trim(); }

  if (s.endsWith('-')) { negative = true; s = s.slice(0, -1).trim(); }
  if (s.startsWith('-')) { negative = true; s = s.slice(1).trim(); }
  else if (s.startsWith('+')) { s = s.slice(1).trim(); }

  // Thousands separators that are never decimal marks anywhere.
  s = s.replace(/[\s\u00a0\u202f\u2019']/g, '');

  if (decimalComma && s.includes(',')) s = s.replace(/\./g, '').replace(',', '.');
  else s = s.replace(/,/g, '');

  if (!/^(\d+(\.\d+)?|\.\d+)$/.test(s)) return null;
  const value = Number(s);
  if (!Number.isFinite(value)) return null;
  return negative ? -value : value;
}

interface ScannedDate {
  format: DateFormatName | 'ambiguous';
  /** Present unless `format` is `'ambiguous'`. */
  iso?: string;
  /** For the ambiguous slash form only. */
  a?: number;
  b?: number;
  year?: number;
  dateAssumed: 'month-end' | null;
}

const pad = (n: number): string => String(n).padStart(2, '0');

/** Build an ISO date, returning null unless it is a real calendar date. */
function isoOf(y: number, m: number, d: number): string | null {
  if (!Number.isInteger(y) || !Number.isInteger(m) || !Number.isInteger(d)) return null;
  if (y < 1000 || y > 9999 || m < 1 || m > 12 || d < 1 || d > 31) return null;
  const t = Date.UTC(y, m - 1, d);
  const back = new Date(t);
  if (back.getUTCFullYear() !== y || back.getUTCMonth() + 1 !== m || back.getUTCDate() !== d) {
    return null; // 31 February and friends
  }
  return `${y}-${pad(m)}-${pad(d)}`;
}

/** Last calendar day of a month, as ISO. */
function monthEndIso(y: number, m: number): string | null {
  if (m < 1 || m > 12 || y < 1000 || y > 9999) return null;
  const d = new Date(Date.UTC(y, m, 0)).getUTCDate();
  return isoOf(y, m, d);
}

/** 00–79 → 20xx, 80–99 → 19xx. The usual two-digit-year convention. */
function expandYear(n: number, digits: number): number {
  if (digits === 4) return n;
  return n < 80 ? 2000 + n : 1900 + n;
}

/**
 * Recognise a date token without deciding day-vs-month order.
 *
 * The ambiguous `A/B/YYYY` form is returned UNRESOLVED, with its components,
 * so the caller can settle the ordering once over the whole file rather than
 * row by row. Deciding per row is how a file ends up with 3 April and 4 March
 * in the same column.
 */
export function scanDate(raw: string): ScannedDate | null {
  const s = raw.trim().replace(/\s+/g, ' ');
  if (!s) return null;
  let m: RegExpExecArray | null;

  // YYYY-MM-DD / YYYY/MM/DD, tolerating unpadded components.
  if ((m = /^(\d{4})[-/](\d{1,2})[-/](\d{1,2})$/.exec(s))) {
    const iso = isoOf(+m[1], +m[2], +m[3]);
    return iso ? { format: s.includes('/') ? 'YYYY/MM/DD' : 'YYYY-MM-DD', iso, dateAssumed: null } : null;
  }
  // YYYY-MM — no day. Month end.
  if ((m = /^(\d{4})[-/](\d{1,2})$/.exec(s))) {
    const iso = monthEndIso(+m[1], +m[2]);
    return iso ? { format: 'YYYY-MM', iso, dateAssumed: 'month-end' } : null;
  }
  // Mon D, YYYY  /  Mon D YYYY
  if ((m = /^([a-z]{3,9})\.? (\d{1,2}),? (\d{4})$/i.exec(s))) {
    const mm = MONTHS[m[1].toLowerCase()];
    if (!mm) return null;
    const iso = isoOf(+m[3], mm, +m[2]);
    return iso ? { format: 'Mon D, YYYY', iso, dateAssumed: null } : null;
  }
  // D Mon YYYY / DD-Mon-YY
  if ((m = /^(\d{1,2})[ \-]([a-z]{3,9})\.?[ \-](\d{2}|\d{4})$/i.exec(s))) {
    const mm = MONTHS[m[2].toLowerCase()];
    if (!mm) return null;
    const iso = isoOf(expandYear(+m[3], m[3].length), mm, +m[1]);
    return iso ? { format: 'D Mon YYYY', iso, dateAssumed: null } : null;
  }
  // Mon YYYY / Mon-YY — no day. Month end.
  if ((m = /^([a-z]{3,9})\.?[ \-](\d{2}|\d{4})$/i.exec(s))) {
    const mm = MONTHS[m[1].toLowerCase()];
    if (!mm) return null;
    const iso = monthEndIso(expandYear(+m[2], m[2].length), mm);
    return iso ? { format: 'Mon YYYY', iso, dateAssumed: 'month-end' } : null;
  }
  // A/B/YYYY — the ambiguous one. Also A.B.YYYY and A-B-YYYY.
  if ((m = /^(\d{1,2})[-/.](\d{1,2})[-/.](\d{2}|\d{4})$/.exec(s))) {
    return {
      format: 'ambiguous',
      a: +m[1], b: +m[2], year: expandYear(+m[3], m[3].length),
      dateAssumed: null,
    };
  }
  return null;
}

/**
 * True when a cell is SHAPED like a date but was rejected as one — `2024-02-31`
 * rather than `not a number`. The two deserve different copy: one is a typo in
 * a real date, the other is not a date at all.
 */
function looksLikeDateShape(s: string): boolean {
  const t = s.trim();
  return /^\d{4}[-/]\d{1,2}[-/]\d{1,2}$/.test(t) ||
    /^\d{1,2}[-/.]\d{1,2}[-/.](\d{2}|\d{4})$/.test(t) ||
    /^[a-z]{3,9}\.? \d{1,2},? \d{4}$/i.test(t);
}

/** Resolve the ambiguous form once the file-wide ordering is known. */
function resolveAmbiguous(d: ScannedDate, dayFirst: boolean): string | null {
  const day = dayFirst ? d.a! : d.b!;
  const month = dayFirst ? d.b! : d.a!;
  return isoOf(d.year!, month, day);
}

type ResolvedType = 'contribution' | 'withdrawal' | 'balance';

interface TypeVerdict {
  type: ResolvedType | null;
  reject?: { reason: SkipReason; message: string };
}

/** Map a type / description cell onto a canonical row type. */
export function resolveType(raw: string): TypeVerdict {
  const v = normaliseWord(raw);
  if (!v) return { type: null };
  for (const group of REJECT_WORDS) {
    if (matchAny(v, group.words)) return { type: null, reject: { reason: group.reason, message: group.message } };
  }
  if (matchAny(v, CONTRIBUTION_WORDS)) return { type: 'contribution' };
  if (matchAny(v, WITHDRAWAL_WORDS)) return { type: 'withdrawal' };
  if (matchAny(v, BALANCE_WORDS)) return { type: 'balance' };
  return { type: null };
}

// ══════════════════════════════════════════════════════════════ the parser

const DELIMITERS: Delimiter[] = [',', '\t', ';', '|'];
const DELIMITER_NAMES: Record<Delimiter, ParseAssumptions['delimiterName']> = {
  ',': 'comma', '\t': 'tab', ';': 'semicolon', '|': 'pipe',
};

interface Line { n: number; text: string }

/** A line's fields plus what each field looked like. Computed once. */
interface Scan {
  line: Line;
  fields: string[];
  dateIdx: number[];
  amountIdx: number[];
  typeIdx: number[];
}

const DEFAULT_MAX_ROWS = 10_000;
const DEFAULT_MAX_CHARS = 5_000_000;

/**
 * Parse pasted text into review-table rows.
 *
 * Never throws. Inspect `outcome` first, then `ambiguities`, then `rows`.
 */
export function parseRows(text: string, options: ParseOptions = {}): ParseResult {
  const maxRows = options.maxRows ?? DEFAULT_MAX_ROWS;
  const maxChars = options.maxChars ?? DEFAULT_MAX_CHARS;
  const sourceLabel = options.sourceLabel ?? 'pasted CSV';

  const empty = (outcome: ParseOutcome, assumptions: ParseAssumptions, stats: ParseStats,
                 summary: string, skipped: SkippedLine[] = [], ignored: IgnoredLine[] = [],
                 ambiguities: ParseAmbiguity[] = []): ParseResult => ({
    outcome, rows: [], skipped, skippedCount: skipped.length, ignored,
    ambiguities, assumptions, stats, summary,
  });

  const blankAssumptions = (): ParseAssumptions => ({
    delimiter: ',', delimiterName: 'comma', delimiterSource: 'default',
    lineEndings: 'none', bomStripped: false, fenced: false,
    columnMapping: 'positional', columns: { date: 0, type: null, amount: 0 },
    header: { present: false, line: null, text: null, names: [] },
    dateFormats: [], dayMonthOrder: null, dayMonthOrderSource: 'not-needed',
    monthOnlyDates: 0, decimalComma: false, impliedType: null,
    negativeIsWithdrawal: null,
  });
  const blankStats = (): ParseStats => ({
    totalLines: 0, blankLines: 0, ignoredLines: 0, dataLines: 0,
    parsed: 0, skipped: 0, truncated: false,
  });

  if (typeof text !== 'string' || text.length === 0) {
    return empty('empty', blankAssumptions(), blankStats(), 'Nothing to read.');
  }
  if (text.length > maxChars) {
    const st = blankStats();
    return empty('too-large', blankAssumptions(), st,
      `That's ${Math.round(text.length / 1e6)}MB of text — more than this can read at once ` +
      `(the limit is ${Math.round(maxChars / 1e6)}MB). Paste a smaller range of dates.`);
  }

  // ── 1. BOM and line endings ───────────────────────────────────────────
  const bomStripped = text.charCodeAt(0) === 0xfeff;
  let body = bomStripped ? text.slice(1) : text;
  const hasCRLF = /\r\n/.test(body);
  const hasLoneCR = /\r(?!\n)/.test(body);
  const hasLF = /(?<!\r)\n/.test(body);
  const lineEndings: ParseAssumptions['lineEndings'] =
    hasCRLF && (hasLoneCR || hasLF) ? 'mixed'
      : hasCRLF ? 'CRLF' : hasLoneCR ? 'CR' : hasLF ? 'LF' : 'none';
  body = body.replace(/\r\n?/g, '\n');

  const rawLines: Line[] = body.split('\n').map((t, i) => ({ n: i + 1, text: t }));
  const totalLines = rawLines.length;

  // ── 2. markdown fences ────────────────────────────────────────────────
  const ignored: IgnoredLine[] = [];
  const fenceIdx = rawLines.filter((l) => /^\s*```/.test(l.text));
  const fenced = fenceIdx.length > 0;
  let lines: Line[] = rawLines;
  if (fenced) {
    // Read only what is inside the fences. Everything else is narration —
    // "Here's your data:" in front, a summary paragraph behind.
    const kept: Line[] = [];
    let inside = false;
    for (const l of rawLines) {
      if (/^\s*```/.test(l.text)) {
        inside = !inside;
        ignored.push({ line: l.n, text: l.text, message: 'Markdown code fence.' });
        continue;
      }
      if (inside) kept.push(l);
      else if (l.text.trim()) ignored.push({ line: l.n, text: l.text, message: 'Text around the table; not read as data.' });
    }
    lines = kept;
  }

  // ── 3. join fields that span lines (a quoted value with a newline) ─────
  const joined: Line[] = [];
  for (let i = 0; i < lines.length; i++) {
    let { n, text: t } = lines[i];
    let guard = 0;
    while (quoteParity(t) % 2 === 1 && i + 1 < lines.length && guard < 20) {
      i++; guard++;
      t += ' ' + lines[i].text;
    }
    joined.push({ n, text: t });
  }

  const blankLines = joined.filter((l) => !l.text.trim()).length;
  const content = joined.filter((l) => l.text.trim().length > 0);
  if (content.length === 0) {
    const st = { ...blankStats(), totalLines, blankLines, ignoredLines: ignored.length };
    return empty('empty', { ...blankAssumptions(), bomStripped, fenced, lineEndings }, st,
      'Nothing to read — the text had no rows in it.', [], ignored);
  }

  // ── 4. delimiter sniff ────────────────────────────────────────────────
  // Score each candidate on how many of the first 20 content lines agree on a
  // field count of 2 or more. Consistency, not raw count: a description column
  // full of commas beats a tab file on count alone and loses on consistency.
  let delimiter: Delimiter = ',';
  let delimiterSource: ParseAssumptions['delimiterSource'] = 'default';
  if (options.delimiter) {
    delimiter = options.delimiter;
    delimiterSource = 'caller';
  } else {
    const sample = content.slice(0, 20);
    let best = -1;
    for (const d of DELIMITERS) {
      const counts = sample.map((l) => splitFields(l.text, d).length).filter((c) => c >= 2);
      if (counts.length === 0) continue;
      const tally = new Map<number, number>();
      for (const c of counts) tally.set(c, (tally.get(c) ?? 0) + 1);
      let modal = 0, modalCount = 0;
      for (const [c, k] of tally) if (k > modalCount || (k === modalCount && c > modal)) { modal = c; modalCount = k; }
      // Agreement dominates; field count breaks ties (2 columns is a weak signal).
      const score = modalCount * 100 + Math.min(modal, 12);
      if (score > best) { best = score; delimiter = d; delimiterSource = 'sniffed'; }
    }
  }
  // A European `;` file writes 1.234,56. Only then is a comma a decimal mark.
  const decimalComma = delimiter === ';' &&
    content.some((l) => splitFields(l.text, ';').some((f) => /^-?[\d.]*\d,\d{1,2}$/.test(f.replace(/[\s$£€¥()]/g, ''))));

  // ── 5. scan every line once ───────────────────────────────────────────
  const isRule = (fs: string[]): boolean => fs.length >= 2 && fs.every((f) => /^:?-{2,}:?$/.test(f) || f === '');
  const scans: Scan[] = [];
  for (const l of content) {
    let fields = splitFields(l.text, delimiter);
    if (delimiter === '|') {
      // `| a | b |` yields an empty field at each end.
      if (fields.length > 2 && fields[0] === '') fields = fields.slice(1);
      if (fields.length > 1 && fields[fields.length - 1] === '') fields = fields.slice(0, -1);
    }
    if (isRule(fields)) { ignored.push({ line: l.n, text: l.text, message: 'Markdown table rule.' }); continue; }
    const dateIdx: number[] = [], amountIdx: number[] = [], typeIdx: number[] = [];
    fields.forEach((f, i) => {
      if (scanDate(f)) dateIdx.push(i);
      else if (parseAmount(f, decimalComma) !== null) amountIdx.push(i);
      const v = resolveType(f);
      if (v.type || v.reject) typeIdx.push(i);
    });
    scans.push({ line: l, fields, dateIdx, amountIdx, typeIdx });
  }

  // ── 6. header and column mapping ──────────────────────────────────────
  // The header is the line immediately before the first line that looks like
  // data. Doing it that way rather than "the first line" survives narration
  // above the table, which is the normal case for a model's output.
  const firstDataAt = scans.findIndex((s) => s.dateIdx.length > 0 && (s.amountIdx.length > 0 || s.fields.length >= 2));
  let headerScan: Scan | null = null;
  if (firstDataAt > 0) {
    const prev = scans[firstDataAt - 1];
    if (prev.fields.length >= 2 && prev.dateIdx.length === 0 && prev.amountIdx.length === 0) headerScan = prev;
  }

  const dataScans = scans.filter((s) => s !== headerScan);

  // Positional mapping from content: modal column index across data lines.
  const modal = (pick: (s: Scan) => number | null): number | null => {
    const tally = new Map<number, number>();
    for (const s of dataScans) {
      const i = pick(s);
      if (i === null) continue;
      tally.set(i, (tally.get(i) ?? 0) + 1);
    }
    let bestIdx: number | null = null, bestN = 0;
    for (const [i, k] of tally) if (k > bestN || (k === bestN && bestIdx !== null && i < bestIdx)) { bestIdx = i; bestN = k; }
    return bestIdx;
  };
  const posDate = modal((s) => (s.dateIdx.length ? s.dateIdx[0] : null));
  const posType = modal((s) => (s.typeIdx.length ? s.typeIdx[0] : null));
  const posAmount = modal((s) => {
    const c = s.amountIdx.filter((i) => i !== posDate && i !== posType);
    return c.length ? c[0] : null;
  });

  // A column that is neither the date nor the amount, holds text, and appears
  // on most rows IS the type column — even when nothing in it was recognised.
  // Without this a `date,Journaled Shares,amount` file reports "no type column"
  // when what it means is "I didn't recognise that type", which sends the user
  // looking for the wrong problem.
  const posTypeFallback = posType ?? modal((s) => {
    const i = s.fields.findIndex((f, k) =>
      k !== posDate && k !== posAmount && f !== '' &&
      parseAmount(f, decimalComma) === null && scanDate(f) === null);
    return i >= 0 ? i : null;
  });

  let columns = { date: posDate ?? 0, type: posTypeFallback, amount: posAmount ?? 1 };
  let columnMapping: ParseAssumptions['columnMapping'] = 'positional';
  let headerNames: string[] = [];
  let amountHeaderIsBalance = false;

  if (headerScan) {
    headerNames = headerScan.fields.map(normaliseHeader);
    const pickByName = (families: string[]): number | null => {
      for (const want of families) {
        const i = headerNames.indexOf(want);
        if (i >= 0) return i;
      }
      for (const want of families) {
        const i = headerNames.findIndex((h) => h.includes(want));
        if (i >= 0) return i;
      }
      return null;
    };
    const hDate = pickByName(DATE_HEADERS);
    const hAmount = pickByName(AMOUNT_HEADERS);
    const hType = pickByName(TYPE_HEADERS);
    if (hDate !== null && hAmount !== null) {
      columns = { date: hDate, type: hType, amount: hAmount };
      columnMapping = 'by-name';
      amountHeaderIsBalance = BALANCE_HEADERS.has(headerNames[hAmount] ?? '');
    }
  }

  // ── 7. settle the day/month question over the whole file ──────────────
  const ambiguous: { scan: Scan; d: ScannedDate }[] = [];
  const dateFormats: DateFormatName[] = [];
  const noteFormat = (f: DateFormatName): void => { if (!dateFormats.includes(f)) dateFormats.push(f); };

  for (const s of dataScans) {
    const cell = s.fields[columns.date];
    if (cell === undefined) continue;
    const d = scanDate(cell);
    if (!d) continue;
    if (d.format === 'ambiguous') ambiguous.push({ scan: s, d });
    else noteFormat(d.format);
  }

  const dayEvidence = ambiguous.filter((x) => x.d.a! > 12);
  const monthEvidence = ambiguous.filter((x) => x.d.b! > 12);
  const asExample = (x: { scan: Scan; d: ScannedDate }): AmbiguityExample => ({
    line: x.scan.line.n,
    text: x.scan.line.text,
    value: x.scan.fields[columns.date],
    asDayFirst: resolveAmbiguous(x.d, true) ?? '(not a real date)',
    asMonthFirst: resolveAmbiguous(x.d, false) ?? '(not a real date)',
  });

  let dayFirst: boolean | null = null;
  let dayMonthOrderSource: ParseAssumptions['dayMonthOrderSource'] = 'not-needed';
  const ambiguities: ParseAmbiguity[] = [];

  if (ambiguous.length > 0) {
    if (dayEvidence.length > 0 && monthEvidence.length > 0) {
      dayMonthOrderSource = 'unresolved';
      ambiguities.push({
        kind: 'day-month-conflict',
        question:
          `This file mixes two date orderings: line ${dayEvidence[0].scan.line.n} ` +
          `(${dayEvidence[0].scan.fields[columns.date]}) can only be day/month, and line ` +
          `${monthEvidence[0].scan.line.n} (${monthEvidence[0].scan.fields[columns.date]}) ` +
          `can only be month/day. No single reading is right — fix the dates, or paste the ` +
          `two halves separately.`,
        dayFirstEvidence: dayEvidence.slice(0, 3).map(asExample),
        monthFirstEvidence: monthEvidence.slice(0, 3).map(asExample),
        readings: null,
        resolveWith: 'dayFirst',
      });
    } else if (dayEvidence.length > 0) {
      dayFirst = true; dayMonthOrderSource = 'evidence';
    } else if (monthEvidence.length > 0) {
      dayFirst = false; dayMonthOrderSource = 'evidence';
    } else if (options.dayFirst !== undefined) {
      dayFirst = options.dayFirst; dayMonthOrderSource = 'caller';
    } else {
      dayMonthOrderSource = 'unresolved';
    }
    if (dayFirst !== null) noteFormat(dayFirst ? 'DD/MM/YYYY' : 'MM/DD/YYYY');
  } else if (options.dayFirst !== undefined) {
    dayFirst = options.dayFirst;
  }

  // ── 8. build rows, under a given day/month reading ────────────────────
  const build = (order: boolean, collectIgnored = false): {
    rows: ParsedRow[]; skipped: SkippedLine[]; monthOnly: number;
    negatives: { line: number; text: string; value: number }[]; positives: number;
    truncated: boolean; dataLines: number;
  } => {
    const rows: ParsedRow[] = [];
    const skipped: SkippedLine[] = [];
    const negatives: { line: number; text: string; value: number }[] = [];
    let positives = 0;
    let monthOnly = 0;
    let truncated = false;
    let dataLines = 0;

    for (const s of dataScans) {
      const dateCell = s.fields[columns.date] ?? '';
      const amountCell = s.fields[columns.amount] ?? '';
      const scanned = scanDate(dateCell);
      const amountValue = parseAmount(amountCell, decimalComma);
      const looksLikeData = s.fields.length >= 2 && (scanned !== null || amountValue !== null);
      if (!looksLikeData) {
        if (collectIgnored) {
          ignored.push({ line: s.line.n, text: s.line.text, message: 'Not a data row; not read.' });
        }
        continue;
      }
      dataLines++;
      if (rows.length >= maxRows) {
        truncated = true;
        skipped.push({
          line: s.line.n, text: s.line.text, reason: 'row-cap',
          message: `Stopped after ${maxRows} rows — that is the most this can hold at once.`,
        });
        continue;
      }

      if (!scanned) {
        skipped.push({
          line: s.line.n, text: s.line.text, reason: dateCell ? 'bad-date' : 'no-date',
          message: !dateCell
            ? 'No date on this line.'
            : looksLikeDateShape(dateCell)
              ? `"${dateCell}" isn't a real calendar date.`
              : `Couldn't read "${dateCell}" as a date. Try 2024-03-15.`,
        });
        continue;
      }
      const iso = scanned.format === 'ambiguous'
        ? resolveAmbiguous(scanned, order)
        : scanned.iso ?? null;
      if (!iso || !/^\d{4}-\d{2}-\d{2}$/.test(iso)) {
        skipped.push({
          line: s.line.n, text: s.line.text, reason: 'bad-date',
          message: `"${dateCell}" isn't a real calendar date.`,
        });
        continue;
      }
      if (amountValue === null) {
        skipped.push({
          line: s.line.n, text: s.line.text, reason: amountCell ? 'bad-amount' : 'no-amount',
          message: amountCell
            ? `Couldn't read "${amountCell}" as an amount.`
            : 'No amount on this line.',
        });
        continue;
      }

      // Type.
      let type: ResolvedType | null = null;
      const typeCol = columns.type;
      if (typeCol !== null) {
        const verdict = resolveType(s.fields[typeCol] ?? '');
        if (verdict.reject) {
          skipped.push({ line: s.line.n, text: s.line.text, ...verdict.reject });
          continue;
        }
        type = verdict.type;
        if (!type) {
          // Fall back to any other column that names a type — a raw export
          // often carries both an `Action` and a `Description`.
          for (const i of s.typeIdx) {
            if (i === columns.date || i === columns.amount) continue;
            const alt = resolveType(s.fields[i]);
            if (alt.reject) { type = null; skipped.push({ line: s.line.n, text: s.line.text, ...alt.reject }); break; }
            if (alt.type) { type = alt.type; break; }
          }
          if (!type) {
            if (skipped[skipped.length - 1]?.line === s.line.n) continue;
            skipped.push({
              line: s.line.n, text: s.line.text, reason: 'unknown-type',
              message:
                `Didn't recognise "${s.fields[typeCol] ?? ''}" as a contribution, a ` +
                `withdrawal or a balance.`,
            });
            continue;
          }
        }
      } else if (amountHeaderIsBalance) {
        type = 'balance';
      } else if (options.assumeNegativeIsWithdrawal === true) {
        type = amountValue < 0 ? 'withdrawal' : 'contribution';
      } else {
        if (amountValue < 0) negatives.push({ line: s.line.n, text: s.line.text, value: amountValue });
        else positives++;
        skipped.push({
          line: s.line.n, text: s.line.text, reason: 'no-type',
          message:
            'This file has no column saying whether a line is a contribution, a ' +
            'withdrawal or a balance.',
        });
        continue;
      }

      if (scanned.dateAssumed) monthOnly++;
      const amount = type === 'balance' ? amountValue : Math.abs(amountValue);
      rows.push({
        date: iso,
        type,
        amount,
        line: s.line.n,
        raw: s.line.text,
        source: `${sourceLabel}, line ${s.line.n}`,
        dateAssumed: scanned.dateAssumed,
      } as ParsedRow);
    }
    return { rows, skipped, monthOnly, negatives, positives, truncated, dataLines };
  };

  const built = build(dayFirst ?? false, true);

  const assumptions: ParseAssumptions = {
    delimiter,
    delimiterName: DELIMITER_NAMES[delimiter],
    delimiterSource,
    lineEndings,
    bomStripped,
    fenced,
    columnMapping,
    columns,
    header: headerScan
      ? { present: true, line: headerScan.line.n, text: headerScan.line.text, names: headerNames }
      : { present: false, line: null, text: null, names: [] },
    dateFormats,
    dayMonthOrder: dayFirst === null ? null : dayFirst ? 'DD/MM' : 'MM/DD',
    dayMonthOrderSource,
    monthOnlyDates: built.monthOnly,
    decimalComma,
    impliedType: columns.type === null && amountHeaderIsBalance ? 'balance' : null,
    negativeIsWithdrawal: options.assumeNegativeIsWithdrawal ?? null,
  };
  const stats: ParseStats = {
    totalLines,
    blankLines,
    ignoredLines: ignored.length,
    dataLines: built.dataLines,
    parsed: built.rows.length,
    skipped: built.skipped.length,
    truncated: built.truncated,
  };

  // ── 9. blocking ambiguities ───────────────────────────────────────────
  if (dayMonthOrderSource === 'unresolved' && ambiguities.length === 0) {
    const first = ambiguous[0];
    const ex = asExample(first);
    ambiguities.push({
      kind: 'day-month-order',
      question:
        `${ex.value} — ${readable(ex.asDayFirst)} or ${readable(ex.asMonthFirst)}? ` +
        `The dates in this file could be day/month or month/day and nothing in it says ` +
        `which. Every date will be read the same way.`,
      examples: ambiguous.slice(0, 3).map(asExample),
      affectedRows: ambiguous.length,
      readings: { dayFirst: build(true).rows, monthFirst: build(false).rows },
      resolveWith: 'dayFirst',
    });
  }
  if (columns.type === null && !amountHeaderIsBalance && options.assumeNegativeIsWithdrawal === undefined
      && built.negatives.length > 0) {
    ambiguities.push({
      kind: 'flow-direction',
      question:
        `This file has amounts but no column saying what they are. ` +
        `${built.negatives.length} of them are negative — should negative amounts be read ` +
        `as withdrawals and positive ones as contributions?`,
      negativeCount: built.negatives.length,
      positiveCount: built.positives,
      examples: built.negatives.slice(0, 3),
      readings: { negativeIsWithdrawal: buildWithOption() },
      resolveWith: 'assumeNegativeIsWithdrawal',
    });
  }

  function buildWithOption(): ParsedRow[] {
    return parseRows(text, { ...options, assumeNegativeIsWithdrawal: true, dayFirst: dayFirst ?? options.dayFirst }).rows;
  }

  if (ambiguities.length > 0) {
    return {
      outcome: 'ambiguous',
      rows: [],
      skipped: built.skipped,
      skippedCount: built.skipped.length,
      ignored,
      ambiguities,
      assumptions,
      stats: { ...stats, parsed: 0 },
      summary: ambiguities[0].question,
    };
  }

  if (built.rows.length === 0) {
    return {
      outcome: 'empty',
      rows: [],
      skipped: built.skipped,
      skippedCount: built.skipped.length,
      ignored,
      ambiguities,
      assumptions,
      stats,
      summary:
        built.skipped.length > 0
          ? `No rows could be read. ${built.skipped.length} ` +
            `${built.skipped.length === 1 ? 'line' : 'lines'} looked like data but ` +
            `couldn't be read.`
          : 'No rows could be read.',
    };
  }

  return {
    outcome: 'ok',
    rows: built.rows,
    skipped: built.skipped,
    skippedCount: built.skipped.length,
    ignored,
    ambiguities,
    assumptions,
    stats,
    summary:
      `Read ${built.rows.length} ${built.rows.length === 1 ? 'row' : 'rows'}.` +
      (built.skipped.length > 0
        ? ` ${built.skipped.length} ${built.skipped.length === 1 ? "line couldn't" : "lines couldn't"} be read.`
        : ''),
  };
}

/** "2024-04-03" → "3 April 2024", for the ambiguity question copy. */
function readable(iso: string): string {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(iso);
  if (!m) return iso;
  const names = ['January', 'February', 'March', 'April', 'May', 'June', 'July',
    'August', 'September', 'October', 'November', 'December'];
  return `${Number(m[3])} ${names[Number(m[2]) - 1]} ${m[1]}`;
}
