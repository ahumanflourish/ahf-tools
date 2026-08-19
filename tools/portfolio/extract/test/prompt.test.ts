/**
 * The prompt.
 *
 * A prompt cannot be unit-tested for whether it works — that needs a model and
 * a set of real statements. What it CAN be tested for is whether a trap that
 * once caused a real error is still in it. Every assertion here corresponds to
 * a mistake that has actually been made: the $11,375 internal transfer, the fee
 * counted as a withdrawal, the quarterly total double-counted against its own
 * year-to-date column.
 *
 * These are regression guards on an editable document, and they are cheap
 * exactly because the alternative — an edit that quietly drops the fee rule —
 * is expensive and silent.
 */

import { describe, expect, it } from 'vitest';

import {
  EXTRACTION_SYSTEM,
  EXTRACTION_USER_TEXT,
  reextractionUserText,
} from '../src/prompt';
import { EXCLUSION_REASONS, SCHEMA_VERSION } from '../src/schema';

const prompt = EXTRACTION_SYSTEM.toLowerCase();

describe('the traps carried over from extraction-prompt.md', () => {
  const inherited: [string, string[]][] = [
    ['internal transfers', ['internal transfer', 'both legs', '11,375']],
    ['quarterly-total reconstruction', ['year-to-date', 'subtracting', 'derived']],
    ['combining multiple accounts', ['combine everything into one set of rows']],
    ['never guessing a number', ['never invent', 'unreadable']],
    ['dividends are not contributions', ['dividends and interest']],
    ['reinvestments are not contributions', ['reinvestments']],
    ['the holdings block stays ticker-and-value', ['do not classify anything']],
  ];

  for (const [name, needles] of inherited) {
    it(`still handles ${name}`, () => {
      for (const needle of needles) {
        expect(prompt, needle).toContain(needle.toLowerCase());
      }
    });
  }
});

describe('the traps added for the enforced-shape world', () => {
  const added: [string, string[]][] = [
    ['period totals rather than balances', ['contributions this period', 'period end']],
    ['double-counting a YTD column against per-quarter figures', ['double-counts']],
    ['fees deducted in-account', ['not a withdrawal', 'already been taken out']],
    ['tax withheld at source', ['tax withheld at source']],
    ['transfers between the user’s own accounts', ['boundary rule', 'rollover']],
    ['balances added across accounts only on shared dates', ['must be added across accounts']],
    ['currency, read rather than assumed', ['read it, do not assume it']],
    ['date-format disambiguation across the whole document', ['whole document, not row by row']],
    ['reversals, corrections and duplicates', ['reversed', 'pending', 'duplicate']],
    ['corporate actions', ['splits, mergers']],
    ['in-kind transfers', ['in-kind transfers']],
    ['employer match being real money in', ['employer matching contributions']],
    ['not synthesising a balance from a flow', ['do not synthesise a balance']],
    ['not spreading a missing period evenly', ['do not spread the gap evenly']],
  ];

  for (const [name, needles] of added) {
    it(`handles ${name}`, () => {
      for (const needle of needles) {
        expect(prompt, needle).toContain(needle.toLowerCase());
      }
    });
  }
});

describe('what the prompt deliberately no longer says', () => {
  it('spends no words on the output format the schema now enforces', () => {
    // The old prompt named the columns, the column order and the comma rules.
    // `output_config.format` carries all three, and the schema's own
    // descriptions carry the field-level meaning.
    for (const gone of ['csv', 'date,type,amount', 'second csv', 'ticker,value']) {
      expect(prompt).not.toContain(gone);
    }
  });

  it('does not ask politely, because there is nobody to ask', () => {
    expect(prompt).not.toContain('please ');
  });

  it('states the schema version it was written against', () => {
    expect(EXTRACTION_SYSTEM).toContain(`schemaVersion\` is ${SCHEMA_VERSION}`);
  });

  it('names every exclusion reason the schema offers, so none is unreachable', () => {
    const unreferenced = EXCLUSION_REASONS.filter(
      (r) => r !== 'other' && !prompt.includes(r),
    );
    expect(unreferenced).toEqual([]);
  });
});

describe('re-extraction', () => {
  it('quotes the correction rather than obeying it', () => {
    const text = reextractionUserText('the September balance is 40,000 not 4,000');
    expect(text).toContain('<correction>');
    expect(text).toContain('do not invent a number to satisfy the report');
    expect(text).toContain('hint about where to look');
  });

  it('falls back to the plain instruction when the note is empty', () => {
    expect(reextractionUserText('   ')).toBe(EXTRACTION_USER_TEXT);
  });
});
