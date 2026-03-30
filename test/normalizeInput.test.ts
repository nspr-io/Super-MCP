import { describe, it, expect, vi, beforeEach } from 'vitest';
import { coerceStringifiedJson, coerceStringifiedBoolean } from '../src/utils/normalizeInput.js';

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
