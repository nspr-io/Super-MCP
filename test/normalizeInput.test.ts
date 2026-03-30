import { describe, it, expect, vi, beforeEach } from 'vitest';
import { coerceStringifiedJson, coerceStringifiedBoolean, coerceStringifiedNumber } from '../src/utils/normalizeInput.js';

vi.mock('../src/logging.js', () => ({
  getLogger: () => ({
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
  }),
}));

const ctx = { handler: 'test', field: 'args' };

describe('coerceStringifiedJson', () => {
  it('returns object as-is when already an object', () => {
    const obj = { query: 'test', limit: 10 };
    expect(coerceStringifiedJson(obj, 'object', ctx)).toBe(obj);
  });

  it('returns array as-is when already an array', () => {
    const arr = ['a', 'b'];
    expect(coerceStringifiedJson(arr, 'array', ctx)).toBe(arr);
  });

  it('parses stringified object when expecting object', () => {
    const result = coerceStringifiedJson('{"query":"test","limit":10}', 'object', ctx);
    expect(result).toEqual({ query: 'test', limit: 10 });
  });

  it('parses stringified array when expecting array', () => {
    const result = coerceStringifiedJson('["tool_a","tool_b"]', 'array', ctx);
    expect(result).toEqual(['tool_a', 'tool_b']);
  });

  it('does not coerce string to object when parsed result is an array', () => {
    const result = coerceStringifiedJson('["a","b"]', 'object', ctx);
    expect(result).toBe('["a","b"]');
  });

  it('does not coerce string to array when parsed result is an object', () => {
    const result = coerceStringifiedJson('{"key":"val"}', 'array', ctx);
    expect(result).toBe('{"key":"val"}');
  });

  it('returns non-string non-object values unchanged', () => {
    expect(coerceStringifiedJson(42, 'object', ctx)).toBe(42);
    expect(coerceStringifiedJson(null, 'object', ctx)).toBe(null);
    expect(coerceStringifiedJson(undefined, 'object', ctx)).toBe(undefined);
    expect(coerceStringifiedJson(true, 'object', ctx)).toBe(true);
  });

  it('returns invalid JSON strings unchanged', () => {
    expect(coerceStringifiedJson('not json', 'object', ctx)).toBe('not json');
    expect(coerceStringifiedJson('{broken', 'object', ctx)).toBe('{broken');
  });

  it('does not coerce string "null" to object', () => {
    expect(coerceStringifiedJson('null', 'object', ctx)).toBe('null');
  });

  it('handles escaped JSON strings (double-encoded)', () => {
    // Double-encoded should only parse one level
    const doubleEncoded = '"{\\"key\\":\\"val\\"}"';
    const result = coerceStringifiedJson(doubleEncoded, 'object', ctx);
    // First parse yields a string, not an object — should not coerce
    expect(typeof result).toBe('string');
  });
});

describe('coerceStringifiedBoolean', () => {
  it('returns boolean true as-is', () => {
    expect(coerceStringifiedBoolean(true, ctx)).toBe(true);
  });

  it('returns boolean false as-is', () => {
    expect(coerceStringifiedBoolean(false, ctx)).toBe(false);
  });

  it('coerces string "true" to boolean true', () => {
    expect(coerceStringifiedBoolean('true', ctx)).toBe(true);
  });

  it('coerces string "false" to boolean false', () => {
    expect(coerceStringifiedBoolean('false', ctx)).toBe(false);
  });

  it('returns other strings unchanged', () => {
    expect(coerceStringifiedBoolean('yes', ctx)).toBe('yes');
    expect(coerceStringifiedBoolean('1', ctx)).toBe('1');
  });

  it('returns non-boolean non-string values unchanged', () => {
    expect(coerceStringifiedBoolean(0, ctx)).toBe(0);
    expect(coerceStringifiedBoolean(null, ctx)).toBe(null);
    expect(coerceStringifiedBoolean(undefined, ctx)).toBe(undefined);
  });
});

describe('coerceStringifiedNumber', () => {
  it('returns number as-is when already a number', () => {
    expect(coerceStringifiedNumber(42, ctx)).toBe(42);
  });

  it('coerces "42" to 42', () => {
    expect(coerceStringifiedNumber('42', ctx)).toBe(42);
  });

  it('coerces "0" to 0', () => {
    expect(coerceStringifiedNumber('0', ctx)).toBe(0);
  });

  it('coerces "3.14" to 3.14', () => {
    expect(coerceStringifiedNumber('3.14', ctx)).toBe(3.14);
  });

  it('coerces "-5" to -5', () => {
    expect(coerceStringifiedNumber('-5', ctx)).toBe(-5);
  });

  it('returns empty string unchanged', () => {
    expect(coerceStringifiedNumber('', ctx)).toBe('');
  });

  it('returns whitespace-only string unchanged', () => {
    expect(coerceStringifiedNumber('   ', ctx)).toBe('   ');
  });

  it('returns non-numeric strings unchanged', () => {
    expect(coerceStringifiedNumber('hello', ctx)).toBe('hello');
  });

  it('returns "NaN" unchanged', () => {
    expect(coerceStringifiedNumber('NaN', ctx)).toBe('NaN');
  });

  it('returns "Infinity" unchanged', () => {
    expect(coerceStringifiedNumber('Infinity', ctx)).toBe('Infinity');
  });

  it('returns non-string non-number values unchanged', () => {
    expect(coerceStringifiedNumber(null, ctx)).toBe(null);
    expect(coerceStringifiedNumber(undefined, ctx)).toBe(undefined);
    expect(coerceStringifiedNumber(true, ctx)).toBe(true);
  });
});
