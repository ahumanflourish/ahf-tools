/**
 * `parseRows` — the CSV / pasted-text parser.
 *
 * EVERY SNIPPET IN THIS FILE IS INVENTED. They are written to the SHAPE of a
 * real brokerage export — the column names, the column order, the quoting, the
 * line endings, the preamble line, the way an amount is signed — but no
 * account number, balance, date or holding here came from a real statement,
 * and nothing here is claimed to be a genuine export of any named firm. The
 * names "Fidelity-style", "Schwab-style" and "Vanguard-style" describe the
 * layout being imitated and nothing more.
 *
 * The point of imitating them rather than writing `date,type,amount` is that
 * the failures only show up in the real shapes: fourteen columns in an order
 * nobody chose, the real figure at index 11 behind a decoy, a `Type` column
 * that means something else, a title line above the header, a thousands
 * separator inside a quoted field, and a CRLF at the end of every line.
 */
import { describe, it, expect } from 'vitest';

import { parseRows, parseAmount, scanDate, splitFields, toDate } from '../src/index';
import type { ParseResult, ParsedRow } from '../src/index';

const BOM = '﻿';

/** Every row a parse emits must be safe to hand to `analyse` unread. */
const expectEngineSafe = (r: ParseResult): void => {
  for (const row of r.rows) {
    expect(row.date).toMatch(/^\d{4}-\d{2}-\d{2}$/);
    expect(Number.isNaN(toDate(row.date).getTime())).toBe(false);
    expect(['contribution', 'withdrawal', 'balance']).toContain(row.type);
    expect(Number.isFinite(row.amount)).toBe(true);
  }
};

const plain = (rows: ParsedRow[]) =>
  rows.map((r) => ({ date: r.date, type: r.type, amount: r.amount }));

// ═══════════════════════════════════════════ 1. the shape people hand-build

describe('the canonical shape', () => {
  const text = [
    'date,type,amount',
    '2021-10-12,contribution,10000',
    '2021-12-31,balance,16500.81',
    '2023-01-15,withdrawal,3000',
  ].join('\n');

  it('reads it', () => {
    const r = parseRows(text);
    expect(r.outcome).toBe('ok');
    expect(plain(r.rows)).toEqual([
      { date: '2021-10-12', type: 'contribution', amount: 10000 },
      { date: '2021-12-31', type: 'balance', amount: 16500.81 },
      { date: '2023-01-15', type: 'withdrawal', amount: 3000 },
    ]);
    expectEngineSafe(r);
  });

  it('detects and skips the header row', () => {
    const r = parseRows(text);
    expect(r.assumptions.header.present).toBe(true);
    expect(r.assumptions.header.line).toBe(1);
    expect(r.assumptions.columnMapping).toBe('by-name');
    expect(r.assumptions.columns).toEqual({ date: 0, type: 1, amount: 2 });
  });

  it('works with no header at all', () => {
    const r = parseRows(text.split('\n').slice(1).join('\n'));
    expect(r.outcome).toBe('ok');
    expect(r.rows).toHaveLength(3);
    expect(r.assumptions.header.present).toBe(false);
    expect(r.assumptions.columnMapping).toBe('positional');
  });

  it('carries provenance back to the line it came from', () => {
    const r = parseRows(text);
    expect(r.rows[0].line).toBe(2);
    expect(r.rows[0].source).toBe('pasted CSV, line 2');
    expect(r.rows[0].raw).toBe('2021-10-12,contribution,10000');
  });

  it('reports what it assumed, so the UI can show it', () => {
    const r = parseRows(text);
    expect(r.assumptions.delimiter).toBe(',');
    expect(r.assumptions.delimiterName).toBe('comma');
    expect(r.assumptions.dateFormats).toEqual(['YYYY-MM-DD']);
    expect(r.summary).toBe('Read 3 rows.');
  });
});

// ═════════════════════════════════════ 2. a Fidelity-style activity export

describe('snippet: Fidelity-style activity export (invented, real shape)', () => {
  // The shape being imitated: `Run Date` first, a verbose `Action` sentence, a
  // `Type` column that holds "Cash" rather than the transaction type, twelve
  // columns, `Amount ($)` at index 10 and negative for a buy, US date order.
  const text = [
    'Run Date,Action,Symbol,Description,Type,Quantity,Price ($),Commission ($),Fees ($),Accrued Interest ($),Amount ($),Settlement Date',
    '08/15/2024,YOU BOUGHT FIDELITY 500 INDEX (FXAIX),FXAIX,FIDELITY 500 INDEX,Cash,27.412,182.40,,,,-5000.00,08/15/2024',
    '09/30/2024,DIVIDEND RECEIVED FIDELITY 500 INDEX (FXAIX),FXAIX,FIDELITY 500 INDEX,Cash,,,,,,118.42,09/30/2024',
    '11/01/2024,YOU SOLD FIDELITY 500 INDEX (FXAIX),FXAIX,FIDELITY 500 INDEX,Cash,-8.100,190.12,,,,"1,539.97",11/01/2024',
    '12/31/2024,ENDING VALUE,,ACCOUNT TOTAL,Cash,,,,,,"48,215.09",12/31/2024',
  ].join('\r\n');

  const r = parseRows(text);

  it('maps columns by NAME, not position — the amount is at index 10', () => {
    expect(r.assumptions.columnMapping).toBe('by-name');
    expect(r.assumptions.columns.amount).toBe(10);
    expect(r.assumptions.columns.date).toBe(0);
  });

  it('reads the verbose Action sentence, not the "Type" column that says Cash', () => {
    expect(plain(r.rows)).toEqual([
      { date: '2024-08-15', type: 'contribution', amount: 5000 },
      { date: '2024-11-01', type: 'withdrawal', amount: 1539.97 },
      { date: '2024-12-31', type: 'balance', amount: 48215.09 },
    ]);
    expectEngineSafe(r);
  });

  it('leaves the dividend out, with its own message', () => {
    expect(r.skipped).toHaveLength(1);
    expect(r.skipped[0].reason).toBe('income-line');
    expect(r.skipped[0].line).toBe(3);
    expect(r.skipped[0].message).toContain('already inside the');
  });

  it('resolves the US date order from 08/15 and 12/31, without asking', () => {
    expect(r.assumptions.dayMonthOrder).toBe('MM/DD');
    expect(r.assumptions.dayMonthOrderSource).toBe('evidence');
    expect(r.ambiguities).toEqual([]);
  });

  it('handles the CRLF line endings and says so', () => {
    expect(r.assumptions.lineEndings).toBe('CRLF');
  });

  it('reports honestly: 3 read, 1 skipped', () => {
    expect(r.summary).toBe("Read 3 rows. 1 line couldn't be read.");
  });
});

// ══════════════════════════════════════ 3. a Schwab-style transaction export

describe('snippet: Schwab-style transaction export (invented, real shape)', () => {
  // The shape being imitated: a quoted title line ABOVE the header, every
  // field quoted, `$` inside the quotes, thousands separators inside the
  // quotes, `Action` holding Buy/Sell, amount last.
  const text = [
    '"Transactions for account XXXX-4417 as of 03/31/2024 11:59 PM ET"',
    '"Date","Action","Symbol","Description","Quantity","Price","Fees & Comm","Amount"',
    '"03/01/2024","Buy","VTI","VANGUARD TOTAL STOCK MKT ETF","10","$245.10","","-$2,451.00"',
    '"03/05/2024","Sell","VTI","VANGUARD TOTAL STOCK MKT ETF","5","$247.00","$0.02","$1,234.98"',
    '"03/18/2024","MoneyLink Transfer","","TRANSFER FROM BANK","","","","$5,000.00"',
    '"03/29/2024","Journal","","ENDING ACCOUNT VALUE","","","","$61,004.22"',
  ].join('\n');

  const r = parseRows(text);

  it('skips the title line above the header without counting it as a failure', () => {
    expect(r.assumptions.header.line).toBe(2);
    expect(r.ignored.some((i) => i.line === 1)).toBe(true);
    expect(r.skipped.some((s) => s.line === 1)).toBe(false);
  });

  it('reads amounts out of quoted fields containing thousands separators', () => {
    expect(plain(r.rows)).toEqual([
      { date: '2024-03-01', type: 'contribution', amount: 2451 },
      { date: '2024-03-05', type: 'withdrawal', amount: 1234.98 },
      { date: '2024-03-29', type: 'balance', amount: 61004.22 },
    ]);
    expectEngineSafe(r);
  });

  it('reports the MoneyLink row rather than guessing its direction', () => {
    // JUDGEMENT. "TRANSFER FROM BANK" with a positive amount is almost
    // certainly a contribution, and "almost certainly" is not good enough to
    // put a number into someone's return. flow-plan §6.10: never infer
    // direction. It is reported, in full, editable in place.
    const s = r.skipped.find((x) => x.line === 5);
    expect(s?.reason).toBe('unknown-type');
    expect(s?.text).toContain('MoneyLink Transfer');
  });
});

// ══════════════════════════════════════ 4. a Vanguard-style transaction export

describe('snippet: Vanguard-style transaction export (invented, real shape)', () => {
  // The shape being imitated: an account-number column first, BOTH a trade and
  // a settlement date, ISO dates, `Transaction Type` at index 3, a `Principal
  // Amount` decoy and the real figure in `Net Amount` at index 11.
  const text = [
    'Account Number,Trade Date,Settlement Date,Transaction Type,Transaction Description,Investment Name,Symbol,Shares,Share Price,Principal Amount,Commission Fees,Net Amount,Accrued Interest,Account Type',
    '84412207,2024-01-16,2024-01-17,Buy,Buy,Vanguard Total Stock Mkt Idx Adm,VTSAX,42.123,118.72,-5000.00,0.00,-5000.00,0.00,Roth IRA',
    '84412207,2024-02-15,2024-02-15,Dividend,Dividend Received,Vanguard Total Stock Mkt Idx Adm,VTSAX,0.000,0.00,58.14,0.00,58.14,0.00,Roth IRA',
    '84412207,2024-06-20,2024-06-21,Sell,Sell,Vanguard Total Stock Mkt Idx Adm,VTSAX,-10.500,127.44,1338.12,0.00,1338.12,0.00,Roth IRA',
    '84412207,2024-09-04,2024-09-04,Advisory Fee,Quarterly advisory fee,,,0.000,0.00,-42.18,0.00,-42.18,0.00,Roth IRA',
  ].join('\n');

  const r = parseRows(text);

  it('prefers the trade date over the settlement date', () => {
    expect(r.assumptions.columns.date).toBe(1);
  });

  it('finds Net Amount at index 11, past the Principal Amount decoy', () => {
    expect(r.assumptions.columns.amount).toBe(11);
    expect(r.assumptions.columns.type).toBe(3);
  });

  it('reads the buy and the sell', () => {
    expect(plain(r.rows)).toEqual([
      { date: '2024-01-16', type: 'contribution', amount: 5000 },
      { date: '2024-06-20', type: 'withdrawal', amount: 1338.12 },
    ]);
    expectEngineSafe(r);
  });

  it('refuses the fee line with the reason that matters', () => {
    const fee = r.skipped.find((s) => s.reason === 'fee-line');
    expect(fee).toBeDefined();
    // A fee is already inside the reported balance. Treating it as a
    // withdrawal would inflate the measured return.
    expect(fee?.message).toContain('inflate the measured return');
  });

  it('refuses the dividend line for the mirror-image reason', () => {
    const div = r.skipped.find((s) => s.reason === 'income-line');
    expect(div?.message).toContain('overstate the money');
  });

  it('ignores the eleven columns it does not need', () => {
    expect(r.rows).toHaveLength(2);
    expect(r.stats.dataLines).toBe(4);
  });
});

// ══════════════════════════════ 5. a spreadsheet export with quoted thousands

describe('snippet: spreadsheet-exported CSV with quoted thousands', () => {
  // The commonest real failure, and INTERACTION.md does not mention it: a
  // naive split(',') turns "1,234.56" into two fields that BOTH still look
  // numeric, so the row parses into silent nonsense rather than an error.
  const text = [
    'Date,Type,Amount',
    '2021-10-12,Contribution,"10,000.00"',
    '2021-12-31,Balance,"16,500.81"',
    '2023-01-15,Withdrawal,"(3,000.00)"',
    '2024-12-31,Ending Value,"1,234,567.89"',
    '2025-06-30,Balance,"$98,765.43"',
    '2025-12-31,Value,"1,048.20-"',
  ].join('\n');

  const r = parseRows(text);

  it('does not split inside the quotes', () => {
    expect(plain(r.rows)).toEqual([
      { date: '2021-10-12', type: 'contribution', amount: 10000 },
      { date: '2021-12-31', type: 'balance', amount: 16500.81 },
      { date: '2023-01-15', type: 'withdrawal', amount: 3000 },
      { date: '2024-12-31', type: 'balance', amount: 1234567.89 },
      { date: '2025-06-30', type: 'balance', amount: 98765.43 },
      { date: '2025-12-31', type: 'balance', amount: -1048.2 },
    ]);
    expect(r.skippedCount).toBe(0);
    expectEngineSafe(r);
  });

  it('reads ($3,000.00) as a negative and stores the flow magnitude', () => {
    // The engine Math.abs()es flows, and flow-plan §1.1 says `amount` is a
    // positive number; direction lives in `type`. A parenthesised WITHDRAWAL
    // is therefore stored as +3000 of withdrawal, not −3000.
    expect(r.rows[2]).toMatchObject({ type: 'withdrawal', amount: 3000 });
  });

  it('leaves a negative BALANCE negative, for the table to reject', () => {
    // Balances are not abs()ed: a negative balance is a real error the review
    // table must catch, and hiding it here would let it reach the maths.
    expect(r.rows[5].amount).toBe(-1048.2);
  });
});

// ════════════════════════════════════════════ 6. a model's fenced output

describe("snippet: a model's markdown-fenced output with prose around it", () => {
  // INTERACTION.md: "Claude's output will not be a bare CSV. It will be
  // wrapped in a markdown fence, preceded by 'Here's your data:', followed by
  // a summary, and may or may not include a header row."
  const text = [
    "Here's what I found in the four statements you uploaded. I've marked the",
    'March 2023 contribution as estimated because the statement only gave a',
    'quarterly total.',
    '',
    '```csv',
    'date,type,amount',
    '2021-10-12,contribution,10000',
    '2021-12-31,balance,16500.81',
    '2023-03-15,contribution,6000',
    '2026-07-31,balance,53690.25',
    '```',
    '',
    'That is 4 rows: $16,000 contributed, ending value $53,690.25. Two of the',
    'dates were inferred. Let me know if anything looks wrong.',
  ].join('\n');

  const r = parseRows(text);

  it('reads only what is inside the fence', () => {
    expect(r.outcome).toBe('ok');
    expect(r.assumptions.fenced).toBe(true);
    expect(r.rows).toHaveLength(4);
    expectEngineSafe(r);
  });

  it('counts the prose as ignored, NOT as lines that failed to parse', () => {
    // Reporting "5 lines couldn't be read" for a sentence teaches the user to
    // ignore the count that matters.
    expect(r.skippedCount).toBe(0);
    expect(r.summary).toBe('Read 4 rows.');
    expect(r.ignored.length).toBeGreaterThan(4);
  });

  it('keeps line numbers pointing at the ORIGINAL paste', () => {
    expect(r.rows[0].line).toBe(7);
    expect(r.rows[0].source).toBe('pasted CSV, line 7');
  });

  it('handles a fence with no language tag and no header row', () => {
    const bare = ['Here you go:', '```', '2021-10-12,contribution,10000',
      '2021-12-31,balance,16500.81', '```', 'Hope that helps.'].join('\n');
    const b = parseRows(bare);
    expect(b.outcome).toBe('ok');
    expect(b.rows).toHaveLength(2);
    expect(b.assumptions.header.present).toBe(false);
  });

  it('handles a fence that is opened and never closed', () => {
    const unclosed = ['Sure:', '```csv', 'date,type,amount',
      '2021-10-12,contribution,10000'].join('\n');
    expect(parseRows(unclosed).rows).toHaveLength(1);
  });

  it('reads a markdown TABLE, which is what a model emits unprompted', () => {
    const md = [
      'Here is the data:',
      '',
      '| Date | Type | Amount |',
      '|------|------|--------|',
      '| 2021-10-12 | Contribution | $10,000 |',
      '| 2021-12-31 | Balance | $16,500.81 |',
    ].join('\n');
    const m = parseRows(md);
    expect(m.assumptions.delimiter).toBe('|');
    expect(plain(m.rows)).toEqual([
      { date: '2021-10-12', type: 'contribution', amount: 10000 },
      { date: '2021-12-31', type: 'balance', amount: 16500.81 },
    ]);
  });
});

// ═════════════════════════════════════════════ 7. BOM, CRLF, trailing blanks

describe('snippet: a file saved by Excel — BOM, CRLF, trailing blank line', () => {
  const rows = ['Date,Type,Amount', '2024-01-31,Balance,48215.09',
    '2024-03-15,Deposit,2000', '2024-12-31,Balance,55120.44'];

  it('strips a UTF-8 BOM and says it did', () => {
    const r = parseRows(BOM + rows.join('\n'));
    expect(r.assumptions.bomStripped).toBe(true);
    expect(r.assumptions.header.present).toBe(true);
    expect(r.assumptions.columnMapping).toBe('by-name');
    expect(r.rows).toHaveLength(3);
  });

  it('without the strip, the BOM would poison the first header name', () => {
    // Named so the guard is a contract: BOM+"Date" is not "Date", and the
    // column mapping silently falls back to positional without this.
    expect((BOM + 'Date').length).toBe(5);
    expect((BOM + 'Date').slice(1)).toBe('Date');
  });

  it('normalises CRLF', () => {
    const r = parseRows(rows.join('\r\n'));
    expect(r.assumptions.lineEndings).toBe('CRLF');
    expect(r.rows).toHaveLength(3);
    expect(r.rows[0].raw.endsWith('\r')).toBe(false);
  });

  it('normalises lone CR, which is what an old Mac export writes', () => {
    const r = parseRows(rows.join('\r'));
    expect(r.assumptions.lineEndings).toBe('CR');
    expect(r.rows).toHaveLength(3);
  });

  it('tolerates a trailing blank line', () => {
    const r = parseRows(rows.join('\n') + '\n');
    expect(r.outcome).toBe('ok');
    expect(r.rows).toHaveLength(3);
    expect(r.skippedCount).toBe(0);
    expect(r.stats.blankLines).toBe(1);
  });

  it('tolerates several trailing blank lines and a trailing CRLF', () => {
    const r = parseRows(rows.join('\r\n') + '\r\n\r\n\r\n');
    expect(r.rows).toHaveLength(3);
    expect(r.skippedCount).toBe(0);
  });

  it('tolerates blank lines in the middle', () => {
    const r = parseRows([rows[0], rows[1], '', rows[2], '', rows[3]].join('\n'));
    expect(r.rows).toHaveLength(3);
    expect(r.skippedCount).toBe(0);
  });

  it('all three together', () => {
    const r = parseRows(BOM + rows.join('\r\n') + '\r\n');
    expect(r.outcome).toBe('ok');
    expect(r.rows).toHaveLength(3);
    expect(r.assumptions.bomStripped).toBe(true);
    expect(r.assumptions.lineEndings).toBe('CRLF');
  });
});

// ═══════════════════════════════════════════════════ 8. delimiters

describe('delimiter sniffing', () => {
  it('sniffs tabs', () => {
    const r = parseRows([
      'Date\tTransaction\tAmount',
      '2024-01-15\tDeposit\t$2,500.00',
      '2024-06-30\tEnding Value\t$31,904.11',
      '2024-09-15\tDistribution\t$1,000.00',
    ].join('\n'));
    expect(r.assumptions.delimiter).toBe('\t');
    expect(r.assumptions.delimiterName).toBe('tab');
    expect(plain(r.rows)).toEqual([
      { date: '2024-01-15', type: 'contribution', amount: 2500 },
      { date: '2024-06-30', type: 'balance', amount: 31904.11 },
      { date: '2024-09-15', type: 'withdrawal', amount: 1000 },
    ]);
  });

  const european = [
    'Date;Type;Amount',
    '15/01/2024;Contribution;1.234,56',
    '28/02/2024;Balance;12.500,00',
    '31/03/2024;Withdrawal;(1.000,00)',
  ].join('\n');

  it('sniffs semicolons, and reads 1.234,56 as 1234.56', () => {
    // A European Excel export uses `;` precisely BECAUSE the comma is the
    // decimal mark. Getting the delimiter right and the decimal wrong turns
    // 1.234,56 into 1.234 — a thousandfold error, silently.
    const r = parseRows(european);
    expect(r.assumptions.delimiter).toBe(';');
    expect(r.assumptions.decimalComma).toBe(true);
    expect(plain(r.rows)).toEqual([
      { date: '2024-01-15', type: 'contribution', amount: 1234.56 },
      { date: '2024-02-28', type: 'balance', amount: 12500 },
      { date: '2024-03-31', type: 'withdrawal', amount: 1000 },
    ]);
  });

  it('reads the European file as day-first, on its own evidence', () => {
    const r = parseRows(european);
    expect(r.assumptions.dayMonthOrder).toBe('DD/MM');
    expect(r.assumptions.dayMonthOrderSource).toBe('evidence');
  });

  it('does not treat a bare 1.234 as European when there is no comma', () => {
    expect(parseAmount('1.234', true)).toBe(1.234);
    expect(parseAmount('1.234,56', true)).toBe(1234.56);
  });

  it('lets the caller override the sniff', () => {
    const r = parseRows('2024-01-15;contribution;1000', { delimiter: ';' });
    expect(r.assumptions.delimiterSource).toBe('caller');
    expect(r.rows).toHaveLength(1);
  });
});

// ══════════════════════════════════════════════════════ 9. dates

describe('dates: every accepted format', () => {
  const one = (d: string) => parseRows(`${d},balance,1000`);

  it('YYYY-MM-DD', () => { expect(one('2024-03-15').rows[0].date).toBe('2024-03-15'); });
  it('YYYY/MM/DD', () => { expect(one('2024/03/15').rows[0].date).toBe('2024-03-15'); });
  it('Mon D, YYYY', () => { expect(one('"Mar 15, 2024"').rows[0].date).toBe('2024-03-15'); });
  it('D Mon YYYY', () => { expect(one('15 March 2024').rows[0].date).toBe('2024-03-15'); });
  it('DD-Mon-YY', () => { expect(one('15-Mar-24').rows[0].date).toBe('2024-03-15'); });

  it('Mon YYYY resolves to the last day of the month, and says so', () => {
    const r = one('Mar 2024');
    expect(r.rows[0].date).toBe('2024-03-31');
    expect(r.rows[0].dateAssumed).toBe('month-end');
    expect(r.assumptions.monthOnlyDates).toBe(1);
    expect(r.assumptions.dateFormats).toEqual(['Mon YYYY']);
  });

  it('YYYY-MM resolves to the last day of the month', () => {
    expect(one('2024-02').rows[0].date).toBe('2024-02-29'); // leap year
  });

  it('marks month-only dates so the table can style them as estimated', () => {
    const r = parseRows(['2024-03-31,balance,1000', 'Apr 2024,balance,1100'].join('\n'));
    expect(r.rows.map((x) => x.dateAssumed)).toEqual([null, 'month-end']);
  });

  it('expands two-digit years: 00-79 to 20xx, 80-99 to 19xx', () => {
    expect(scanDate('15-Mar-05')?.iso).toBe('2005-03-15');
    expect(scanDate('15-Mar-95')?.iso).toBe('1995-03-15');
  });

  it('reports every distinct format it met', () => {
    const r = parseRows([
      'date,type,amount',
      '2021-10-12,contribution,10000',
      'Dec 2021,balance,16500.81',
      '15-Mar-2023,withdrawal,3000',
      '2024-12-31,balance,41000',
      '"Jul 31, 2026",balance,53690.25',
    ].join('\n'));
    expect(r.outcome).toBe('ok');
    expect(r.rows).toHaveLength(5);
    expect([...r.assumptions.dateFormats].sort()).toEqual(
      ['D Mon YYYY', 'Mon D, YYYY', 'Mon YYYY', 'YYYY-MM-DD']);
    expectEngineSafe(r);
  });
});

describe('dates: the normalisation guard the engine does not have', () => {
  // `toDate` is `new Date(s + 'T00:00:00Z')`, so `2024-1-5` yields Invalid
  // Date, which becomes NaN in `daysBetween` and propagates into the results
  // with NO error raised anywhere. Nothing in the engine validates a date.
  it('normalises an unpadded date rather than passing it through', () => {
    const r = parseRows('2024-1-5,balance,1000');
    expect(r.rows[0].date).toBe('2024-01-05');
    expect(Number.isNaN(toDate('2024-1-5').getTime())).toBe(true);
    expect(Number.isNaN(toDate(r.rows[0].date).getTime())).toBe(false);
  });

  it('rejects a date that is not a real calendar day', () => {
    const r = parseRows('2024-02-31,balance,1000');
    expect(r.outcome).toBe('empty');
    expect(r.skipped[0].reason).toBe('bad-date');
    expect(r.skipped[0].message).toContain("isn't a real calendar date");
  });

  it('rejects 31 February however it is spelled', () => {
    expect(parseRows('31/02/2024,balance,1000').rows).toHaveLength(0);
    expect(parseRows('"Feb 31, 2024",balance,1000').rows).toHaveLength(0);
  });

  it('every emitted date is strict YYYY-MM-DD, across a deliberately messy file', () => {
    const messy = [
      'date,type,amount',
      '2024-1-5,contribution,1000',
      'Mar 2024,balance,2000',
      '15-Apr-24,contribution,500',
      '"Jun 30, 2024",balance,2600',
      '2024/07/01,withdrawal,100',
    ].join('\n');
    const r = parseRows(messy);
    expect(r.rows).toHaveLength(5);
    expectEngineSafe(r);
    expect(r.rows.map((x) => x.date)).toEqual([
      '2024-01-05', '2024-03-31', '2024-04-15', '2024-06-30', '2024-07-01']);
  });
});

describe('dates: ambiguity is reported, never guessed', () => {
  const text = [
    'Date,Type,Amount',
    '03/04/2024,Contribution,5000',
    '05/06/2024,Balance,52000',
    '07/08/2024,Withdrawal,1200',
  ].join('\n');

  const r = parseRows(text);

  it('names the outcome `ambiguous` and returns NO rows', () => {
    // Deliberate: a caller that forgets to check `outcome` shows an empty
    // table and is visibly broken, rather than a full table of dates that are
    // silently wrong by a month.
    expect(r.outcome).toBe('ambiguous');
    expect(r.rows).toEqual([]);
  });

  it('asks a question a person can answer', () => {
    const a = r.ambiguities[0];
    expect(a.kind).toBe('day-month-order');
    expect(a.question).toContain('03/04/2024');
    expect(a.question).toContain('3 April 2024');
    expect(a.question).toContain('4 March 2024');
  });

  it('says how many rows the answer applies to, and shows examples', () => {
    const a = r.ambiguities[0];
    if (a.kind !== 'day-month-order') throw new Error('wrong kind');
    expect(a.affectedRows).toBe(3);
    expect(a.examples[0]).toMatchObject({
      line: 2, value: '03/04/2024', asDayFirst: '2024-04-03', asMonthFirst: '2024-03-04',
    });
  });

  it('attaches both complete readings so the UI can preview each', () => {
    const a = r.ambiguities[0];
    if (a.kind !== 'day-month-order') throw new Error('wrong kind');
    expect(a.readings.dayFirst.map((x) => x.date))
      .toEqual(['2024-04-03', '2024-06-05', '2024-08-07']);
    expect(a.readings.monthFirst.map((x) => x.date))
      .toEqual(['2024-03-04', '2024-05-06', '2024-07-08']);
  });

  it('re-parsing with the answer produces exactly the previewed reading', () => {
    const a = r.ambiguities[0];
    if (a.kind !== 'day-month-order') throw new Error('wrong kind');
    const answered = parseRows(text, { dayFirst: true });
    expect(answered.outcome).toBe('ok');
    expect(plain(answered.rows)).toEqual(plain(a.readings.dayFirst));
    expect(answered.assumptions.dayMonthOrder).toBe('DD/MM');
    expect(answered.assumptions.dayMonthOrderSource).toBe('caller');
  });

  it('does not ask when the file settles it — one 13th of the month is enough', () => {
    const r2 = parseRows(text.replace('05/06/2024', '05/13/2024'));
    expect(r2.outcome).toBe('ok');
    expect(r2.assumptions.dayMonthOrder).toBe('MM/DD');
    expect(r2.assumptions.dayMonthOrderSource).toBe('evidence');
    expect(r2.rows[0].date).toBe('2024-03-04');
  });

  it('the file overrules the caller — evidence beats a supplied preference', () => {
    const r3 = parseRows(text.replace('05/06/2024', '13/06/2024'), { dayFirst: false });
    expect(r3.assumptions.dayMonthOrder).toBe('DD/MM');
    expect(r3.assumptions.dayMonthOrderSource).toBe('evidence');
  });

  it('refuses a file that proves BOTH orderings, and says which lines', () => {
    const conflicted = ['Date,Type,Amount', '31/01/2024,Contribution,5000',
      '01/31/2024,Balance,52000'].join('\n');
    const c = parseRows(conflicted);
    expect(c.outcome).toBe('ambiguous');
    expect(c.rows).toEqual([]);
    const a = c.ambiguities[0];
    expect(a.kind).toBe('day-month-conflict');
    if (a.kind !== 'day-month-conflict') throw new Error('wrong kind');
    expect(a.readings).toBeNull();
    expect(a.dayFirstEvidence[0].line).toBe(2);
    expect(a.monthFirstEvidence[0].line).toBe(3);
  });

  it('never asks about ISO dates', () => {
    expect(parseRows('2024-03-04,balance,1000').assumptions.dayMonthOrderSource)
      .toBe('not-needed');
  });
});

// ═══════════════════════════════════════════════════ 10. amounts and types

describe('amounts', () => {
  it('strips currency symbols', () => {
    expect(parseAmount('$3,000')).toBe(3000);
    expect(parseAmount('£1,250.50')).toBe(1250.5);
    expect(parseAmount('€999')).toBe(999);
    expect(parseAmount('1250.50 USD')).toBe(1250.5);
  });

  it('reads parenthesised negatives — ($3,000) is minus three thousand', () => {
    expect(parseAmount('($3,000)')).toBe(-3000);
    expect(parseAmount('(1,234.56)')).toBe(-1234.56);
  });

  it('reads a trailing minus and CR/DR suffixes', () => {
    expect(parseAmount('3,000-')).toBe(-3000);
    expect(parseAmount('1,000.00 DR')).toBe(-1000);
    expect(parseAmount('1,000.00 CR')).toBe(1000);
  });

  it('strips thousands separators of every kind', () => {
    expect(parseAmount("1'234.56")).toBe(1234.56);
    expect(parseAmount('1 234.56')).toBe(1234.56);
    expect(parseAmount('1 234.56')).toBe(1234.56);
  });

  it('refuses things that are not amounts, rather than returning NaN', () => {
    expect(parseAmount('2024-03-15')).toBeNull();
    expect(parseAmount('7.2%')).toBeNull();
    expect(parseAmount('VTSAX')).toBeNull();
    expect(parseAmount('')).toBeNull();
    expect(parseAmount('-')).toBeNull();
    expect(parseAmount('1.2.3')).toBeNull();
  });
});

describe('type synonyms, case-insensitive', () => {
  const typeOf = (t: string) => parseRows(`2024-03-15,${t},1000`).rows[0]?.type;

  it('contribution family', () => {
    for (const t of ['contribution', 'CONTRIBUTION', 'Deposit', 'buy', 'Bought',
      'Purchase', 'Employer Match', 'transfer in', 'Rollover In', 'employee_contribution']) {
      expect([t, typeOf(t)]).toEqual([t, 'contribution']);
    }
  });

  it('withdrawal family', () => {
    for (const t of ['withdrawal', 'Withdrawal', 'DISTRIBUTION', 'sell', 'Sold',
      'Redemption', 'transfer-out', 'Cash Out']) {
      expect([t, typeOf(t)]).toEqual([t, 'withdrawal']);
    }
  });

  it('balance family', () => {
    for (const t of ['balance', 'Balance', 'value', 'Ending Value', 'ENDING BALANCE',
      'Market Value', 'Account Value', 'closing balance']) {
      expect([t, typeOf(t)]).toEqual([t, 'balance']);
    }
  });

  it('matches inside a description sentence, on word boundaries', () => {
    expect(typeOf('YOU BOUGHT FIDELITY 500 INDEX')).toBe('contribution');
    expect(typeOf('Automatic investment - deposit from checking')).toBe('contribution');
  });

  it('does not fire on a word that merely contains a synonym', () => {
    const r = parseRows('2024-03-15,Coffee Shop Rebate,1000');
    expect(r.rows).toHaveLength(0);
    expect(r.skipped[0].reason).toBe('unknown-type');
  });

  it('reports an unrecognised type instead of dropping the row', () => {
    const r = parseRows(['2024-03-15,Journaled Shares,1000',
      '2024-03-16,balance,50000'].join('\n'));
    expect(r.rows).toHaveLength(1);
    expect(r.skippedCount).toBe(1);
    expect(r.skipped[0].reason).toBe('unknown-type');
    expect(r.skipped[0].text).toBe('2024-03-15,Journaled Shares,1000');
  });
});

describe('a file with no type column', () => {
  it('reads a balance-history export as balances, and says it assumed that', () => {
    const r = parseRows([
      'Date,Ending Value',
      '2023-12-31,"41,002.18"',
      '2024-12-31,"48,215.09"',
      '2025-12-31,"55,120.44"',
    ].join('\n'));
    expect(r.outcome).toBe('ok');
    expect(r.assumptions.impliedType).toBe('balance');
    expect(r.rows.every((x) => x.type === 'balance')).toBe(true);
  });

  it('will not guess direction from the sign — it asks', () => {
    // flow-plan §6.10: "Signed-amount files with no type column: offer 'treat
    // negatives as withdrawals' as an explicit checkbox with a preview. Never
    // infer it."
    const text = ['Date,Amount', '2024-01-15,5000', '2024-06-20,-1200'].join('\n');
    const r = parseRows(text);
    expect(r.outcome).toBe('ambiguous');
    expect(r.rows).toEqual([]);
    const a = r.ambiguities[0];
    expect(a.kind).toBe('flow-direction');
    if (a.kind !== 'flow-direction') throw new Error('wrong kind');
    expect(a.negativeCount).toBe(1);
    expect(a.readings.negativeIsWithdrawal.map((x) => x.type))
      .toEqual(['contribution', 'withdrawal']);
  });

  it('honours the answer when it is given', () => {
    const r = parseRows(['Date,Amount', '2024-01-15,5000', '2024-06-20,-1200'].join('\n'),
      { assumeNegativeIsWithdrawal: true });
    expect(r.outcome).toBe('ok');
    expect(plain(r.rows)).toEqual([
      { date: '2024-01-15', type: 'contribution', amount: 5000 },
      { date: '2024-06-20', type: 'withdrawal', amount: 1200 },
    ]);
    expect(r.assumptions.negativeIsWithdrawal).toBe(true);
  });
});

// ══════════════════════════════════════════════ 11. failure, reported

describe('snippet: a paste that is entirely unparseable', () => {
  const text = [
    'YOUR ACCOUNT AT A GLANCE',
    'Prepared for JANE Q SAMPLE',
    'Account ending in 4417',
    'Statement period: the quarter ending 31 March',
    'Questions? Call 1-800-555-0100 between 8am and 8pm ET.',
  ].join('\n');

  const r = parseRows(text);

  it('is `empty` — a named outcome, not an empty array', () => {
    // INTERACTION.md: "On zero parseable rows, show the raw input alongside
    // the expected format rather than a generic error." A caller cannot tell
    // "no rows" from "no input" from an empty array alone.
    expect(r.outcome).toBe('empty');
    expect(r.rows).toEqual([]);
  });

  it('does not throw', () => {
    expect(() => parseRows(text)).not.toThrow();
  });

  it('says so in prose the UI can render', () => {
    expect(r.summary).toContain('No rows could be read');
  });

  it('hands back everything it saw, so the UI can show the raw input', () => {
    expect(r.stats.totalLines).toBe(5);
    expect(r.ignored).toHaveLength(5);
    expect(r.ignored.map((i) => i.text)).toEqual(text.split('\n'));
  });

  it('claims no header it did not find', () => {
    expect(r.assumptions.header.present).toBe(false);
  });

  it('an empty string is `empty` too', () => {
    expect(parseRows('').outcome).toBe('empty');
    expect(parseRows('   \n\n  ').outcome).toBe('empty');
  });
});

describe('skipped lines are counted and quoted, never dropped', () => {
  const text = [
    'date,type,amount',
    '2021-10-12,contribution,10000',
    '2021-13-45,balance,16500.81',
    '2023-01-15,withdrawal,not a number',
    '2023-06-30,Journaled Shares,4000',
    '2024-12-31,balance,41000',
  ].join('\n');

  const r = parseRows(text);

  it('reads what it can', () => {
    expect(r.rows).toHaveLength(2);
    expectEngineSafe(r);
  });

  it('reports the count in the exact copy the flow plan asks for', () => {
    expect(r.skippedCount).toBe(3);
    expect(r.summary).toBe("Read 2 rows. 3 lines couldn't be read.");
  });

  it('quotes each failed line verbatim, with a line number and a reason', () => {
    expect(r.skipped.map((s) => [s.line, s.reason])).toEqual([
      [3, 'bad-date'], [4, 'bad-amount'], [5, 'unknown-type'],
    ]);
    expect(r.skipped[1].text).toBe('2023-01-15,withdrawal,not a number');
    expect(r.skipped[1].message).toContain('not a number');
  });

  it('uses the singular for one line', () => {
    const one = parseRows(['2021-10-12,contribution,10000',
      '2021-13-45,balance,1'].join('\n'));
    expect(one.summary).toBe("Read 1 row. 1 line couldn't be read.");
  });
});

describe('caps', () => {
  it('stops at maxRows and reports it rather than hanging', () => {
    const many = Array.from({ length: 50 },
      (_, i) => `2024-01-${String((i % 28) + 1).padStart(2, '0')},balance,${1000 + i}`).join('\n');
    const r = parseRows(many, { maxRows: 10 });
    expect(r.rows).toHaveLength(10);
    expect(r.stats.truncated).toBe(true);
    expect(r.skipped[0].reason).toBe('row-cap');
    expect(r.skipped[0].message).toContain('10 rows');
  });

  it('refuses text over maxChars with a named outcome, not a hung tab', () => {
    const r = parseRows('x'.repeat(2_000_000), { maxChars: 1_000_000 });
    expect(r.outcome).toBe('too-large');
    expect(r.rows).toEqual([]);
    expect(r.summary).toContain('more than this can read at once');
  });
});

// ══════════════════════════════════════════════════ 12. purity and contracts

describe('purity and contracts', () => {
  it('is deterministic', () => {
    const t = 'date,type,amount\n2024-03-15,balance,1000';
    expect(parseRows(t)).toEqual(parseRows(t));
  });

  it('never throws, on anything', () => {
    for (const bad of ['', ' ', '"', '"""', ',,,,', '\n\n\n', '```',
      '```\n```', 'a'.repeat(10_000), BOM, '|||', ';;;;']) {
      expect(() => parseRows(bad)).not.toThrow();
    }
  });

  it('splitFields honours RFC-4180 quoting, including escaped quotes', () => {
    expect(splitFields('a,"b,c",d', ',')).toEqual(['a', 'b,c', 'd']);
    expect(splitFields('a,"say ""hi""",d', ',')).toEqual(['a', 'say "hi"', 'd']);
    expect(splitFields('a,"1,234.56",d', ',')).toEqual(['a', '1,234.56', 'd']);
    expect(splitFields('a,b"c,d', ',')).toEqual(['a', 'b"c', 'd']);
    expect(splitFields('', ',')).toEqual(['']);
  });

  it('joins a quoted field that spans two lines', () => {
    const r = parseRows([
      'date,description,amount',
      '2024-03-15,"Contribution,',
      'employer match",5000',
    ].join('\n'));
    expect(plain(r.rows)).toEqual([
      { date: '2024-03-15', type: 'contribution', amount: 5000 },
    ]);
  });

  it('emits rows assignable to InputRow, with the extra fields the table needs', () => {
    const r = parseRows('2024-03-15,balance,1000');
    const row = r.rows[0];
    expect(Object.keys(row).sort()).toEqual(
      ['amount', 'date', 'dateAssumed', 'line', 'raw', 'source', 'type']);
  });

  it('lets the caller label the source', () => {
    const r = parseRows('2024-03-15,balance,1000', { sourceLabel: 'statement.csv' });
    expect(r.rows[0].source).toBe('statement.csv, line 1');
  });
});
