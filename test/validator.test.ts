import { describe, it, expect } from 'vitest';
import { Validator, ValidationError } from '../src/validator.js';

describe('Validator', () => {
  it('should pass validation for valid data', () => {
    const validator = new Validator();
    const schema = {
      type: 'object',
      properties: {
        name: { type: 'string' },
        age: { type: 'number' }
      },
      required: ['name']
    };

    expect(() => validator.validate(schema, { name: 'test', age: 25 })).not.toThrow();
  });

  it('should throw ValidationError for missing required field', () => {
    const validator = new Validator();
    const schema = {
      type: 'object',
      properties: {
        name: { type: 'string' }
      },
      required: ['name']
    };

    expect(() => validator.validate(schema, {})).toThrow(ValidationError);
  });

  it('should throw ValidationError for invalid type', () => {
    const validator = new Validator();
    const schema = {
      type: 'object',
      properties: {
        age: { type: 'number' }
      }
    };

    expect(() => validator.validate(schema, { age: 'not-a-number' })).toThrow(ValidationError);
  });

  it('should throw ValidationError when schema is missing', () => {
    const validator = new Validator();
    expect(() => validator.validate(null, {})).toThrow(ValidationError);
  });

  describe('arg stripping (additionalProperties: false)', () => {
    it('strips unknown top-level properties and returns their names', () => {
      const validator = new Validator();
      const schema = {
        type: 'object',
        properties: {
          query: { type: 'string' },
        },
        required: ['query'],
        additionalProperties: false,
      };
      const data = { query: 'test', limit: 10, mode: 'fast' };
      const stripped = validator.validate(schema, data);
      expect(stripped).toEqual(['limit', 'mode']);
      expect(data).toEqual({ query: 'test' });
    });

    it('returns empty array when no unknown properties', () => {
      const validator = new Validator();
      const schema = {
        type: 'object',
        properties: {
          query: { type: 'string' },
        },
        additionalProperties: false,
      };
      const stripped = validator.validate(schema, { query: 'test' });
      expect(stripped).toEqual([]);
    });

    it('does not strip when additionalProperties is not false', () => {
      const validator = new Validator();
      const schema = {
        type: 'object',
        properties: {
          query: { type: 'string' },
        },
      };
      const data = { query: 'test', extra: 'value' };
      const stripped = validator.validate(schema, data);
      expect(stripped).toEqual([]);
      expect(data).toHaveProperty('extra');
    });

    it('handles null and non-object data gracefully', () => {
      const validator = new Validator();
      const schema = { type: 'string' };
      const stripped = validator.validate(schema, 'hello');
      expect(stripped).toEqual([]);
    });
  });
});
