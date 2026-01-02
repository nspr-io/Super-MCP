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
});
