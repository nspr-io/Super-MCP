import { describe, it, expect } from 'vitest';
import { summarizePackage, argsSkeleton, createSchemaHash } from '../src/summarize.js';

// ---------------------------------------------------------------------------
// summarizePackage
// ---------------------------------------------------------------------------

describe('summarizePackage', () => {
  it('returns "Local MCP package (no tools loaded)." for stdio with 0 tools', () => {
    const config = { transport: 'stdio' };
    expect(summarizePackage(config, [])).toBe('Local MCP package (no tools loaded).');
  });

  it('returns "Remote MCP package (no tools loaded)." for http without oauth and 0 tools', () => {
    const config = { transport: 'http' };
    expect(summarizePackage(config, [])).toBe('Remote MCP package (no tools loaded).');
  });

  it('returns "Cloud (OAuth) MCP package (no tools loaded)." for http with oauth and 0 tools', () => {
    const config = { transport: 'http', oauth: { client_id: 'x' } };
    expect(summarizePackage(config, [])).toBe('Cloud (OAuth) MCP package (no tools loaded).');
  });

  it('returns tool count with description for http+oauth with tools', () => {
    const config = { transport: 'http', oauth: { client_id: 'x' }, description: 'Some description' };
    const tools = Array.from({ length: 5 }, (_, i) => ({ name: `tool_${i}` }));
    expect(summarizePackage(config, tools)).toBe('Cloud (OAuth) MCP with 5 tools. Some description');
  });

  it('returns tool count without description for http without oauth', () => {
    const config = { transport: 'http' };
    const tools = Array.from({ length: 3 }, (_, i) => ({ name: `tool_${i}` }));
    expect(summarizePackage(config, tools)).toBe('Remote MCP with 3 tools.');
  });

  it('returns tool count for stdio with tools and no description', () => {
    const config = { transport: 'stdio' };
    const tools = [{ name: 'read_file' }, { name: 'write_file' }];
    expect(summarizePackage(config, tools)).toBe('Local MCP with 2 tools.');
  });

  it('returns tool count for stdio with tools and a description', () => {
    const config = { transport: 'stdio', description: 'File system operations.' };
    const tools = [{ name: 'read_file' }];
    expect(summarizePackage(config, tools)).toBe('Local MCP with 1 tools. File system operations.');
  });
});

// ---------------------------------------------------------------------------
// argsSkeleton
// ---------------------------------------------------------------------------

describe('argsSkeleton', () => {
  it('returns empty object for null/undefined schema', () => {
    expect(argsSkeleton(null)).toEqual({});
    expect(argsSkeleton(undefined)).toEqual({});
  });

  it('returns empty object for non-object schema', () => {
    expect(argsSkeleton('string')).toEqual({});
    expect(argsSkeleton(42)).toEqual({});
  });

  it('returns skeleton for object schema with properties', () => {
    const schema = {
      type: 'object',
      properties: {
        name: { type: 'string' },
        age: { type: 'integer' },
        active: { type: 'boolean' },
      },
    };
    expect(argsSkeleton(schema)).toEqual({
      name: '<string>',
      age: '<number>',
      active: '<boolean>',
    });
  });

  it('handles string format hints (uri, email, date, date-time)', () => {
    const schema = {
      type: 'object',
      properties: {
        website: { type: 'string', format: 'uri' },
        contact: { type: 'string', format: 'email' },
        birthday: { type: 'string', format: 'date' },
        created_at: { type: 'string', format: 'date-time' },
      },
    };
    expect(argsSkeleton(schema)).toEqual({
      website: '<url>',
      contact: '<email>',
      birthday: '<date>',
      created_at: '<datetime>',
    });
  });

  it('handles key-based hints (path, id)', () => {
    const schema = {
      type: 'object',
      properties: {
        file_path: { type: 'string' },
        user_id: { type: 'string' },
      },
    };
    expect(argsSkeleton(schema)).toEqual({
      file_path: '<path>',
      user_id: '<id>',
    });
  });

  it('handles array properties', () => {
    const schema = {
      type: 'object',
      properties: {
        tags: { type: 'array', items: { type: 'string' } },
        items: { type: 'array' },
      },
    };
    expect(argsSkeleton(schema)).toEqual({
      tags: ['<string>'],
      items: ['<item>'],
    });
  });

  it('handles nested object properties', () => {
    const schema = {
      type: 'object',
      properties: {
        config: {
          type: 'object',
          properties: {
            enabled: { type: 'boolean' },
            name: { type: 'string' },
          },
        },
      },
    };
    expect(argsSkeleton(schema)).toEqual({
      config: {
        enabled: '<boolean>',
        name: '<string>',
      },
    });
  });

  it('handles enum values (returns first enum value)', () => {
    const schema = {
      type: 'object',
      properties: {
        mode: { enum: ['fast', 'slow', 'medium'] },
      },
    };
    expect(argsSkeleton(schema)).toEqual({
      mode: 'fast',
    });
  });

  it('returns <value> for unknown types', () => {
    const schema = {
      type: 'object',
      properties: {
        unknown: {},
      },
    };
    expect(argsSkeleton(schema)).toEqual({
      unknown: '<value>',
    });
  });
});

// ---------------------------------------------------------------------------
// createSchemaHash
// ---------------------------------------------------------------------------

describe('createSchemaHash', () => {
  it('returns "empty" for null/undefined schema', () => {
    expect(createSchemaHash(null)).toBe('empty');
    expect(createSchemaHash(undefined)).toBe('empty');
  });

  it('returns stable hash for the same input', () => {
    const schema = { type: 'object', properties: { name: { type: 'string' } } };
    const hash1 = createSchemaHash(schema);
    const hash2 = createSchemaHash(schema);
    expect(hash1).toBe(hash2);
  });

  it('returns different hashes for different inputs', () => {
    const schema1 = { type: 'object', properties: { name: { type: 'string' } } };
    const schema2 = { type: 'object', properties: { age: { type: 'number' } } };
    expect(createSchemaHash(schema1)).not.toBe(createSchemaHash(schema2));
  });

  it('returns hash with sha256: prefix', () => {
    const schema = { type: 'string' };
    expect(createSchemaHash(schema)).toMatch(/^sha256:[0-9a-f]+$/);
  });
});
