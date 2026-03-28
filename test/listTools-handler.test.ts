import { describe, it, expect, vi, beforeEach } from 'vitest';
import { handleListTools } from '../src/handlers/listTools.js';
import type { Catalog } from '../src/catalog.js';
import type { PackageRegistry } from '../src/registry.js';
import { ERROR_CODES } from '../src/types.js';

// Suppress logger output during tests
vi.mock('../src/logging.js', () => ({
  getLogger: () => ({
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
  }),
}));

// Shared mock security policy — same instance returned by every getSecurityPolicy() call
const mockSecurityPolicy = {
  isToolBlocked: vi.fn().mockReturnValue({ blocked: false }),
  isUserDisabled: vi.fn().mockReturnValue(false),
  isAdminDisabled: vi.fn().mockReturnValue(false),
};

vi.mock('../src/security.js', () => ({
  getSecurityPolicy: () => mockSecurityPolicy,
}));

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Build a mock CachedTool-like structure that buildToolInfos returns as ToolInfo */
function makeTool(name: string, opts: {
  description?: string;
  summary?: string;
  argsSkeleton?: any;
  schemaHash?: string;
  inputSchema?: any;
} = {}) {
  return {
    package_id: 'test-pkg',
    tool_id: `test-pkg__${name}`,
    name: `test-pkg__${name}`,
    description: opts.description ?? `Description for ${name}`,
    summary: opts.summary ?? `Summary for ${name}`,
    args_skeleton: opts.argsSkeleton ?? { arg1: '<string>' },
    schema_hash: opts.schemaHash ?? `sha256:${name}hash`,
    schema: opts.inputSchema ?? { type: 'object', properties: { arg1: { type: 'string' } } },
  };
}

/**
 * Create a mock Catalog that returns tools based on the options passed to buildToolInfos.
 * Simulates the real Catalog's behavior by omitting fields when summarize/include_schemas are false.
 */
function createMockCatalog(tools: ReturnType<typeof makeTool>[]): Catalog {
  return {
    ensurePackageLoaded: vi.fn().mockResolvedValue(undefined),
    getPackageStatus: vi.fn().mockReturnValue('ready'),
    getPackageError: vi.fn().mockReturnValue(undefined),
    buildToolInfos: vi.fn().mockImplementation((_pkgId: string, options: any = {}) => {
      const { summarize = true, include_schemas = true, include_descriptions = false } = options;

      return Promise.resolve(
        tools.map(t => ({
          package_id: t.package_id,
          tool_id: t.tool_id,
          name: t.name,
          description: include_descriptions ? t.description : undefined,
          summary: summarize ? t.summary : undefined,
          args_skeleton: summarize ? t.args_skeleton : undefined,
          schema_hash: t.schema_hash,
          schema: include_schemas ? t.schema : undefined,
        }))
      );
    }),
  } as unknown as Catalog;
}

/** Create a minimal mock registry */
function createMockRegistry(catalogId?: string): PackageRegistry {
  return {
    getPackage: vi.fn().mockReturnValue(catalogId ? { catalogId } : undefined),
  } as unknown as PackageRegistry;
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('handleListTools — detail parameter', () => {
  const sampleTools = [
    makeTool('send_email', {
      description: 'Send an email',
      summary: 'Sends emails via Gmail',
      argsSkeleton: { to: '<email>', subject: '<string>', body: '<string>' },
      inputSchema: {
        type: 'object',
        properties: {
          to: { type: 'string', format: 'email' },
          subject: { type: 'string' },
          body: { type: 'string' },
        },
        required: ['to', 'subject'],
      },
    }),
    makeTool('read_inbox', {
      description: 'Read inbox messages',
      summary: 'Lists recent inbox messages',
      argsSkeleton: { limit: '<number>' },
      inputSchema: {
        type: 'object',
        properties: {
          limit: { type: 'number' },
        },
      },
    }),
  ];

  let catalog: Catalog;
  let registry: PackageRegistry;

  beforeEach(() => {
    catalog = createMockCatalog(sampleTools);
    registry = createMockRegistry();
  });

  // -----------------------------------------------------------------------
  // detail: "lite"
  // -----------------------------------------------------------------------

  it('detail: "lite" returns descriptions but NO args_skeleton and NO schema', async () => {
    const result = await handleListTools(
      { package_id: 'test-pkg', detail: 'lite' },
      catalog,
      null,
      registry,
    );

    expect(result.isError).toBe(false);
    const parsed = JSON.parse(result.content[0].text);
    expect(parsed.tools).toHaveLength(2);

    for (const tool of parsed.tools) {
      expect(tool.description).toBeTruthy();
      expect(tool.args_skeleton).toBeUndefined();
      expect(tool.schema).toBeUndefined();
      expect(tool.summary).toBeUndefined();
      expect(tool.schema_hash).toBeTruthy();
    }

    // Verify buildToolInfos was called with summarize=false, include_schemas=false, include_descriptions=true
    expect(catalog.buildToolInfos).toHaveBeenCalledWith('test-pkg', {
      summarize: false,
      include_schemas: false,
      include_descriptions: true,
    });
  });

  // -----------------------------------------------------------------------
  // detail: "full"
  // -----------------------------------------------------------------------

  it('detail: "full" returns descriptions, args_skeleton, AND schema', async () => {
    const result = await handleListTools(
      { package_id: 'test-pkg', detail: 'full' },
      catalog,
      null,
      registry,
    );

    expect(result.isError).toBe(false);
    const parsed = JSON.parse(result.content[0].text);
    expect(parsed.tools).toHaveLength(2);

    for (const tool of parsed.tools) {
      expect(tool.description).toBeTruthy();
      expect(tool.args_skeleton).toBeDefined();
      expect(tool.schema).toBeDefined();
      expect(tool.summary).toBeTruthy();
    }

    // Verify buildToolInfos was called with summarize=true, include_schemas=true, include_descriptions=true
    expect(catalog.buildToolInfos).toHaveBeenCalledWith('test-pkg', {
      summarize: true,
      include_schemas: true,
      include_descriptions: true,
    });
  });

  // -----------------------------------------------------------------------
  // detail not provided — backward compatibility with old boolean params
  // -----------------------------------------------------------------------

  it('no detail + summarize: true, include_schemas: false → backward-compatible (has summary, no schema)', async () => {
    const result = await handleListTools(
      { package_id: 'test-pkg', summarize: true, include_schemas: false },
      catalog,
      null,
      registry,
    );

    expect(result.isError).toBe(false);
    const parsed = JSON.parse(result.content[0].text);

    for (const tool of parsed.tools) {
      expect(tool.description).toBeTruthy();
      expect(tool.summary).toBeTruthy();
      expect(tool.args_skeleton).toBeDefined();
      expect(tool.schema).toBeUndefined();
    }

    // Verify the old params were passed through directly (include_descriptions always true)
    expect(catalog.buildToolInfos).toHaveBeenCalledWith('test-pkg', {
      summarize: true,
      include_schemas: false,
      include_descriptions: true,
    });
  });

  // -----------------------------------------------------------------------
  // detail overrides old booleans when both provided
  // -----------------------------------------------------------------------

  it('detail: "lite" overrides summarize: true, include_schemas: true', async () => {
    const result = await handleListTools(
      { package_id: 'test-pkg', detail: 'lite', summarize: true, include_schemas: true },
      catalog,
      null,
      registry,
    );

    expect(result.isError).toBe(false);
    const parsed = JSON.parse(result.content[0].text);

    for (const tool of parsed.tools) {
      expect(tool.args_skeleton).toBeUndefined();
      expect(tool.schema).toBeUndefined();
      expect(tool.summary).toBeUndefined();
      expect(tool.description).toBeTruthy();
    }

    // detail: "lite" should override the booleans
    expect(catalog.buildToolInfos).toHaveBeenCalledWith('test-pkg', {
      summarize: false,
      include_schemas: false,
      include_descriptions: true,
    });
  });

  it('detail: "full" overrides summarize: false, include_schemas: false', async () => {
    const result = await handleListTools(
      { package_id: 'test-pkg', detail: 'full', summarize: false, include_schemas: false },
      catalog,
      null,
      registry,
    );

    expect(result.isError).toBe(false);
    const parsed = JSON.parse(result.content[0].text);

    for (const tool of parsed.tools) {
      expect(tool.summary).toBeTruthy();
      expect(tool.args_skeleton).toBeDefined();
      expect(tool.schema).toBeDefined();
    }

    // detail: "full" should override the booleans
    expect(catalog.buildToolInfos).toHaveBeenCalledWith('test-pkg', {
      summarize: true,
      include_schemas: true,
      include_descriptions: true,
    });
  });

  // -----------------------------------------------------------------------
  // Invalid detail value
  // -----------------------------------------------------------------------

  it('invalid detail value throws INVALID_PARAMS error', async () => {
    await expect(
      handleListTools(
        { package_id: 'test-pkg', detail: 'medium' as any },
        catalog,
        null,
        registry,
      )
    ).rejects.toMatchObject({
      code: ERROR_CODES.INVALID_PARAMS,
      message: expect.stringContaining('Invalid detail value: "medium"'),
    });

    // Should fail before calling buildToolInfos
    expect(catalog.buildToolInfos).not.toHaveBeenCalled();
  });

  // -----------------------------------------------------------------------
  // Security annotations work with both detail levels
  // -----------------------------------------------------------------------

  it('security annotations are applied with detail: "lite"', async () => {
    // Override shared mock for this test to block a specific tool
    mockSecurityPolicy.isToolBlocked.mockImplementation((_pkgId: string, toolId: string) => {
      if (toolId === 'send_email') {
        return { blocked: true, reason: 'Blocked by security policy' };
      }
      return { blocked: false };
    });

    const result = await handleListTools(
      { package_id: 'test-pkg', detail: 'lite' },
      catalog,
      null,
      registry,
    );

    expect(result.isError).toBe(false);
    const parsed = JSON.parse(result.content[0].text);

    const blockedTool = parsed.tools.find((t: any) => t.tool_id === 'test-pkg__send_email');
    expect(blockedTool.blocked).toBe(true);
    expect(blockedTool.blocked_reason).toBe('Blocked by security policy');

    const normalTool = parsed.tools.find((t: any) => t.tool_id === 'test-pkg__read_inbox');
    expect(normalTool.blocked).toBeUndefined();

    // Reset for other tests
    mockSecurityPolicy.isToolBlocked.mockReturnValue({ blocked: false });
  });

  it('security annotations are applied with detail: "full"', async () => {
    // Override shared mock for this test to disable a specific tool
    mockSecurityPolicy.isUserDisabled.mockImplementation((_pkgId: string, toolId: string) => {
      return toolId === 'read_inbox';
    });

    const result = await handleListTools(
      { package_id: 'test-pkg', detail: 'full' },
      catalog,
      null,
      registry,
    );

    expect(result.isError).toBe(false);
    const parsed = JSON.parse(result.content[0].text);

    const disabledTool = parsed.tools.find((t: any) => t.tool_id === 'test-pkg__read_inbox');
    expect(disabledTool.blocked).toBe(true);
    expect(disabledTool.user_disabled).toBe(true);

    const normalTool = parsed.tools.find((t: any) => t.tool_id === 'test-pkg__send_email');
    expect(normalTool.blocked).toBeUndefined();
    expect(normalTool.schema).toBeDefined();
    expect(normalTool.args_skeleton).toBeDefined();

    // Reset for other tests
    mockSecurityPolicy.isUserDisabled.mockReturnValue(false);
  });

  // -----------------------------------------------------------------------
  // Default behavior when no params are provided at all
  // -----------------------------------------------------------------------

  it('defaults (no detail, no booleans) use summarize=true, include_schemas=true', async () => {
    const result = await handleListTools(
      { package_id: 'test-pkg' },
      catalog,
      null,
      registry,
    );

    expect(result.isError).toBe(false);
    expect(catalog.buildToolInfos).toHaveBeenCalledWith('test-pkg', {
      summarize: true,
      include_schemas: true,
      include_descriptions: true,
    });
  });
});
