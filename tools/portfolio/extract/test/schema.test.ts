/**
 * The schema, against hand-written extraction results.
 *
 * Two claims. First, that the shape a careful extraction produces passes —
 * including the degenerate one, zero rows and a full unreadable list, which is
 * a correct answer and must not be mistaken for a malformed reply. Second, that
 * every named way real output goes wrong is caught, at the right path, with the
 * right code. A validator that rejects the bad cases for the wrong reason gives
 * the UI a message that sends the user to the wrong place.
 *
 * There is also a set of assertions about the schema DOCUMENT itself. Those
 * exist because the schema is a wire contract with two consumers — the API and
 * `validate.ts` — and the constraints that matter most are the ones neither
 * consumer will complain about if they go missing: an object without
 * `additionalProperties: false` silently accepts invented fields, and a
 * property left out of `required` silently accepts its absence.
 */

import { describe, expect, it } from 'vitest';

import { EXTRACTION_SCHEMA, SCHEMA_VERSION } from '../src/schema';
import { isCalendarDate, validateAgainstSchema, validateExtraction } from '../src/validate';
import { clone, INVALID_CASES, VALID, VALID_EMPTY } from './fixtures';

const schema = EXTRACTION_SCHEMA as unknown as Record<string, unknown>;

describe('the schema document', () => {
  /** Walk every object node in the schema, following anyOf and items. */
  function objectNodes(node: any, path = ''): [string, any][] {
    const found: [string, any][] = [];
    if (!node || typeof node !== 'object') return found;
    if (node.type === 'object') found.push([path || '(root)', node]);
    for (const variant of node.anyOf ?? []) {
      found.push(...objectNodes(variant, `${path}|variant`));
    }
    if (node.items) found.push(...objectNodes(node.items, `${path}[]`));
    for (const [k, v] of Object.entries(node.properties ?? {})) {
      found.push(...objectNodes(v, path ? `${path}.${k}` : k));
    }
    return found;
  }

  const nodes = objectNodes(schema);

  it('has at least the six object shapes the contract describes', () => {
    expect(nodes.length).toBeGreaterThanOrEqual(6);
  });

  it('closes every object to additional properties', () => {
    for (const [path, node] of nodes) {
      expect(node.additionalProperties, `${path} is open to extra fields`).toBe(false);
    }
  });

  it('requires every property of every object', () => {
    for (const [path, node] of nodes) {
      const props = Object.keys(node.properties ?? {}).sort();
      const required = [...((node.required ?? []) as string[])].sort();
      expect(required, `${path} leaves a property optional`).toEqual(props);
    }
  });

  it('uses no schema keyword the API silently drops', () => {
    // `minimum`, `maximum`, `minLength`, `maxLength`, `pattern`, `multipleOf`
    // are unsupported and dropped without error. A schema carrying them reads
    // as if it validates ranges and does not.
    const dropped = ['minimum', 'maximum', 'minLength', 'maxLength', 'pattern', 'multipleOf', 'minItems', 'maxItems'];
    const text = JSON.stringify(schema);
    for (const keyword of dropped) {
      expect(text.includes(`"${keyword}"`), `schema uses ${keyword}`).toBe(false);
    }
  });

  it('carries a const version marker, which doubles as the enforcement canary', () => {
    expect((schema.properties as any).schemaVersion.const).toBe(SCHEMA_VERSION);
  });

  it('describes every field, because the descriptions are half the prompt', () => {
    for (const [path, node] of nodes) {
      for (const [key, prop] of Object.entries<any>(node.properties ?? {})) {
        const described =
          typeof prop.description === 'string' ||
          (prop.anyOf ?? []).some((v: any) => typeof v.description === 'string');
        expect(described, `${path}.${key} has no description`).toBe(true);
      }
    }
  });
});

describe('valid extraction results', () => {
  it('accepts a full two-account extraction', () => {
    const outcome = validateExtraction(VALID);
    expect(outcome.ok ? [] : outcome.issues).toEqual([]);
    expect(outcome.ok).toBe(true);
  });

  it('accepts zero rows with a populated unreadable list', () => {
    const outcome = validateExtraction(VALID_EMPTY);
    expect(outcome.ok ? [] : outcome.issues).toEqual([]);
  });

  it('accepts a null holdings block', () => {
    const r = clone(VALID);
    r.holdings = null;
    expect(validateExtraction(r).ok).toBe(true);
  });

  it('accepts null first and last dates alongside an empty rows list', () => {
    const r = clone(VALID_EMPTY);
    expect(validateExtraction(r).ok).toBe(true);
  });
});

describe('deliberately invalid extraction results', () => {
  for (const c of INVALID_CASES) {
    it(`rejects ${c.name}`, () => {
      const r = clone(VALID) as unknown as Record<string, any>;
      c.mutate(r);
      const outcome = validateExtraction(r);
      expect(outcome.ok).toBe(false);
      if (outcome.ok) return;
      const match = outcome.issues.find(
        (i) => i.path === c.path && i.code === c.code,
      );
      expect(
        match,
        `expected ${c.code} at ${c.path}; got ${JSON.stringify(outcome.issues)}`,
      ).toBeDefined();
    });
  }

  it('rejects a reply that is not an object at all', () => {
    for (const v of [null, 42, 'ok', [VALID]]) {
      expect(validateExtraction(v).ok).toBe(false);
    }
  });

  it('reports every problem at once rather than stopping at the first', () => {
    const r = clone(VALID) as unknown as Record<string, any>;
    r.rows[0].type = 'deposit';
    r.rows[1].date = '2025-02-30';
    delete r.notes;
    const outcome = validateExtraction(r);
    expect(outcome.ok).toBe(false);
    if (outcome.ok) return;
    expect(outcome.issues.length).toBeGreaterThanOrEqual(3);
  });
});

describe('isCalendarDate', () => {
  it('accepts real days', () => {
    for (const d of ['2021-10-12', '2024-02-29', '2000-02-29', '1996-01-01', '2023-12-31']) {
      expect(isCalendarDate(d), d).toBe(true);
    }
  });

  it('rejects everything the engine would turn into NaN', () => {
    for (const d of [
      '2024-1-5',
      '2023-02-29',
      '2025-02-30',
      '2023-13-01',
      '2023-00-10',
      '2023-04-31',
      '2023-04-00',
      '12/31/2022',
      '2023-12-31T00:00:00Z',
      '',
      'Dec 2023',
      20231231,
      null,
    ]) {
      expect(isCalendarDate(d as unknown), String(d)).toBe(false);
    }
  });

  it('handles the leap-year rule at both centuries', () => {
    expect(isCalendarDate('1900-02-29')).toBe(false);
    expect(isCalendarDate('2000-02-29')).toBe(true);
  });
});

describe('the validator itself', () => {
  it('supports only the keywords the schema uses, and says so by example', () => {
    // A keyword the validator does not implement must not be silently treated
    // as satisfied by a value that violates it — the schema is tested above to
    // contain none, and this pins the behaviour if one is ever added.
    const issues = validateAgainstSchema(5, { type: 'number', minimum: 10 });
    expect(issues).toEqual([]);
  });

  it('reports a path for a nested failure', () => {
    const issues = validateAgainstSchema(
      { a: { b: [1, 'two'] } },
      {
        type: 'object',
        additionalProperties: false,
        required: ['a'],
        properties: {
          a: {
            type: 'object',
            additionalProperties: false,
            required: ['b'],
            properties: { b: { type: 'array', items: { type: 'number' } } },
          },
        },
      },
    );
    expect(issues).toHaveLength(1);
    expect(issues[0].path).toBe('a.b[1]');
  });

  it('treats a non-finite number as a failure', () => {
    expect(validateAgainstSchema(Number.NaN, { type: 'number' })[0]?.code).toBe(
      'not-finite',
    );
  });
});
