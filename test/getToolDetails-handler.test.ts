import { describe, it, expect, vi, beforeEach } from 'vitest';
import { handleGetToolDetails } from '../src/handlers/getToolDetails.js';
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

// Shared mock security policy
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

interface MockToolDef {
  name: string;
  description: string;
  summary: string;
  argsSkeleton: any;
  schemaHash: string;
  inputSchema: any;
}

function makeToolDef(name: string, opts: Partial<MockToolDef> = {}): MockToolDef {
  return {
    name,
    description: opts.description ?? `Description for ${name}`,
    summary: opts.summary ?? `Summary for ${name}`,
    argsSkeleton: opts.argsSkeleton ?? { arg1: '<string>' },
    schemaHash: opts.schemaHash ?? `sha256:${name}hash`,
    inputSchema: opts.inputSchema ?? { type: 'object', properties: { arg1: { type: 'string' } } },
  };
}

/**
 * Create a mock Catalog. Tools are stored by packageId -> toolName.
 */
function createMockCatalog(
  toolsByPackage: Record<string, MockToolDef[]>,
  packageStatuses: Record<string, 'ready' | 'auth_required' | 'error'> = {},
  packageErrors: Record<string, string> = {}
): Catalog {
  return {
    ensurePackageLoaded: vi.fn().mockResolvedValue(undefined),
    getPackageStatus: vi.fn().mockImplementation((pkgId: string) =>
      packageStatuses[pkgId] ?? 'ready'
    ),
    getPackageError: vi.fn().mockImplementation((pkgId: string) =>
      packageErrors[pkgId]
    ),
    getTool: vi.fn().mockImplementation(async (pkgId: string, toolName: string) => {
      const pkgTools = toolsByPackage[pkgId];
      if (!pkgTools) return undefined;
      const found = pkgTools.find(t => t.name === toolName);
      if (!found) return undefined;
      return {
        packageId: pkgId,
        tool: {
          name: found.name,
          description: found.description,
          inputSchema: found.inputSchema,
        },
        summary: found.summary,
        argsSkeleton: found.argsSkeleton,
        schemaHash: found.schemaHash,
      };
    }),
  } as unknown as Catalog;
}

/** Create a minimal mock registry */
function createMockRegistry(catalogIds: Record<string, string> = {}): PackageRegistry {
  return {
    getPackage: vi.fn().mockImplementation((pkgId: string) =>
      catalogIds[pkgId] ? { catalogId: catalogIds[pkgId] } : undefined
    ),
  } as unknown as PackageRegistry;
}

/** Parse the JSON result from handleGetToolDetails response */
function parseResult(result: any): { tools: any[] } {
  expect(result.isError).toBe(false);
  return JSON.parse(result.content[0].text);
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('handleGetToolDetails', () => {
  let registry: PackageRegistry;

  beforeEach(() => {
    registry = createMockRegistry();
    mockSecurityPolicy.isToolBlocked.mockReturnValue({ blocked: false });
    mockSecurityPolicy.isUserDisabled.mockReturnValue(false);
    mockSecurityPolicy.isAdminDisabled.mockReturnValue(false);
  });

  // -----------------------------------------------------------------------
  // Basic resolution
  // -----------------------------------------------------------------------

  it('single tool_id returns full ToolInfo with schema', async () => {
    const catalog = createMockCatalog({
      'gmail': [makeToolDef('send_email', {
        description: 'Send an email',
        summary: 'Sends emails',
        argsSkeleton: { to: '<email>', subject: '<string>' },
        inputSchema: { type: 'object', properties: { to: { type: 'string' }, subject: { type: 'string' } } },
        schemaHash: 'sha256:abc123',
      })],
    });

    const result = await handleGetToolDetails(
      { tool_ids: ['gmail__send_email'] },
      catalog,
      registry,
    );

    const parsed = parseResult(result);
    expect(parsed.tools).toHaveLength(1);
    const tool = parsed.tools[0];
    expect(tool.package_id).toBe('gmail');
    expect(tool.tool_id).toBe('gmail__send_email');
    expect(tool.description).toBe('Send an email');
    expect(tool.summary).toBe('Sends emails');
    expect(tool.args_skeleton).toEqual({ to: '<email>', subject: '<string>' });
    expect(tool.schema).toEqual({ type: 'object', properties: { to: { type: 'string' }, subject: { type: 'string' } } });
    expect(tool.schema_hash).toBe('sha256:abc123');
    expect(tool.not_found).toBeUndefined();
    expect(tool.error).toBeUndefined();
  });

  it('multiple tool_ids from same package returns all', async () => {
    const catalog = createMockCatalog({
      'gmail': [
        makeToolDef('send_email'),
        makeToolDef('read_inbox'),
      ],
    });

    const result = await handleGetToolDetails(
      { tool_ids: ['gmail__send_email', 'gmail__read_inbox'] },
      catalog,
      registry,
    );

    const parsed = parseResult(result);
    expect(parsed.tools).toHaveLength(2);
    expect(parsed.tools.map((t: any) => t.tool_id)).toContain('gmail__send_email');
    expect(parsed.tools.map((t: any) => t.tool_id)).toContain('gmail__read_inbox');
  });

  it('multiple tool_ids across packages returns all', async () => {
    const catalog = createMockCatalog({
      'gmail': [makeToolDef('send_email')],
      'slack': [makeToolDef('post_message')],
    });

    const result = await handleGetToolDetails(
      { tool_ids: ['gmail__send_email', 'slack__post_message'] },
      catalog,
      registry,
    );

    const parsed = parseResult(result);
    expect(parsed.tools).toHaveLength(2);

    const gmailTool = parsed.tools.find((t: any) => t.package_id === 'gmail');
    expect(gmailTool.tool_id).toBe('gmail__send_email');

    const slackTool = parsed.tools.find((t: any) => t.package_id === 'slack');
    expect(slackTool.tool_id).toBe('slack__post_message');
  });

  // -----------------------------------------------------------------------
  // Not found handling
  // -----------------------------------------------------------------------

  it('tool_id not found returns not_found: true', async () => {
    const catalog = createMockCatalog({
      'gmail': [makeToolDef('send_email')],
    });

    const result = await handleGetToolDetails(
      { tool_ids: ['gmail__nonexistent_tool'] },
      catalog,
      registry,
    );

    const parsed = parseResult(result);
    expect(parsed.tools).toHaveLength(1);
    expect(parsed.tools[0].not_found).toBe(true);
    expect(parsed.tools[0].tool_id).toBe('gmail__nonexistent_tool');
  });

  it('tool_id with no __ separator returns not_found with format error', async () => {
    const catalog = createMockCatalog({});

    const result = await handleGetToolDetails(
      { tool_ids: ['invalid-tool-id'] },
      catalog,
      registry,
    );

    const parsed = parseResult(result);
    expect(parsed.tools).toHaveLength(1);
    expect(parsed.tools[0].not_found).toBe(true);
    expect(parsed.tools[0].package_id).toBe('');
    expect(parsed.tools[0].description).toContain('Invalid tool ID format');
  });

  it('tool_id with embedded __ (e.g., pkg__tool__name) correctly parses package and tool', async () => {
    const catalog = createMockCatalog({
      'pkg': [makeToolDef('tool__name', { description: 'A tool with __ in name' })],
    });

    const result = await handleGetToolDetails(
      { tool_ids: ['pkg__tool__name'] },
      catalog,
      registry,
    );

    const parsed = parseResult(result);
    expect(parsed.tools).toHaveLength(1);
    expect(parsed.tools[0].package_id).toBe('pkg');
    expect(parsed.tools[0].tool_id).toBe('pkg__tool__name');
    expect(parsed.tools[0].description).toBe('A tool with __ in name');
    expect(parsed.tools[0].not_found).toBeUndefined();

    // Verify getTool was called with correct rawName
    expect(catalog.getTool).toHaveBeenCalledWith('pkg', 'tool__name');
  });

  // -----------------------------------------------------------------------
  // Validation errors
  // -----------------------------------------------------------------------

  it('more than 10 tool_ids throws INVALID_PARAMS', async () => {
    const catalog = createMockCatalog({});

    await expect(
      handleGetToolDetails(
        { tool_ids: Array.from({ length: 11 }, (_, i) => `pkg__tool_${i}`) },
        catalog,
        registry,
      )
    ).rejects.toMatchObject({
      code: ERROR_CODES.INVALID_PARAMS,
      message: expect.stringContaining('exceeds maximum of 10'),
    });
  });

  it('empty array throws INVALID_PARAMS', async () => {
    const catalog = createMockCatalog({});

    await expect(
      handleGetToolDetails(
        { tool_ids: [] },
        catalog,
        registry,
      )
    ).rejects.toMatchObject({
      code: ERROR_CODES.INVALID_PARAMS,
      message: expect.stringContaining('non-empty array'),
    });
  });

  it('non-string tool_id in array throws INVALID_PARAMS', async () => {
    const catalog = createMockCatalog({});

    await expect(
      handleGetToolDetails(
        { tool_ids: [42 as any] },
        catalog,
        registry,
      )
    ).rejects.toMatchObject({
      code: ERROR_CODES.INVALID_PARAMS,
      message: expect.stringContaining('non-empty string'),
    });
  });

  it('empty string tool_id throws INVALID_PARAMS', async () => {
    const catalog = createMockCatalog({});

    await expect(
      handleGetToolDetails(
        { tool_ids: [''] },
        catalog,
        registry,
      )
    ).rejects.toMatchObject({
      code: ERROR_CODES.INVALID_PARAMS,
      message: expect.stringContaining('non-empty string'),
    });
  });

  it('whitespace-only tool_id throws INVALID_PARAMS', async () => {
    const catalog = createMockCatalog({});

    await expect(
      handleGetToolDetails(
        { tool_ids: ['   '] },
        catalog,
        registry,
      )
    ).rejects.toMatchObject({
      code: ERROR_CODES.INVALID_PARAMS,
      message: expect.stringContaining('non-empty string'),
    });
  });

  // -----------------------------------------------------------------------
  // Package-level failures
  // -----------------------------------------------------------------------

  it('package auth_required returns error: "package_unavailable"', async () => {
    const catalog = createMockCatalog(
      { 'notion': [] },
      { 'notion': 'auth_required' },
    );

    const result = await handleGetToolDetails(
      { tool_ids: ['notion__create_page'] },
      catalog,
      registry,
    );

    const parsed = parseResult(result);
    expect(parsed.tools).toHaveLength(1);
    expect(parsed.tools[0].error).toBe('package_unavailable');
    expect(parsed.tools[0].description).toContain('requires authentication');
    expect(parsed.tools[0].not_found).toBeUndefined();
  });

  it('package error returns error: "package_unavailable" with reason', async () => {
    const catalog = createMockCatalog(
      { 'broken': [] },
      { 'broken': 'error' },
      { 'broken': 'Connection timeout' },
    );

    const result = await handleGetToolDetails(
      { tool_ids: ['broken__some_tool'] },
      catalog,
      registry,
    );

    const parsed = parseResult(result);
    expect(parsed.tools).toHaveLength(1);
    expect(parsed.tools[0].error).toBe('package_unavailable');
    expect(parsed.tools[0].description).toContain('Connection timeout');
    expect(parsed.tools[0].not_found).toBeUndefined();
  });

  it('package load exception returns error: "package_unavailable"', async () => {
    const catalog = createMockCatalog({});
    (catalog.ensurePackageLoaded as any).mockRejectedValueOnce(new Error('Network failure'));

    const result = await handleGetToolDetails(
      { tool_ids: ['failing__some_tool'] },
      catalog,
      registry,
    );

    const parsed = parseResult(result);
    expect(parsed.tools).toHaveLength(1);
    expect(parsed.tools[0].error).toBe('package_unavailable');
    expect(parsed.tools[0].description).toContain("Failed to load package 'failing'");
  });

  // -----------------------------------------------------------------------
  // Security annotations
  // -----------------------------------------------------------------------

  it('blocked tool is annotated with blocked: true', async () => {
    const catalog = createMockCatalog({
      'gmail': [makeToolDef('send_email')],
    });

    mockSecurityPolicy.isToolBlocked.mockImplementation((_pkgId: string, toolId: string) => {
      if (toolId === 'send_email') {
        return { blocked: true, reason: 'Tool is blocked by security policy' };
      }
      return { blocked: false };
    });

    const result = await handleGetToolDetails(
      { tool_ids: ['gmail__send_email'] },
      catalog,
      registry,
    );

    const parsed = parseResult(result);
    expect(parsed.tools[0].blocked).toBe(true);
    expect(parsed.tools[0].blocked_reason).toBe('Tool is blocked by security policy');

    mockSecurityPolicy.isToolBlocked.mockReturnValue({ blocked: false });
  });

  it('admin-disabled tool is annotated correctly', async () => {
    registry = createMockRegistry({ 'gmail': 'bundled-google' });
    const catalog = createMockCatalog({
      'gmail': [makeToolDef('send_email')],
    });

    mockSecurityPolicy.isAdminDisabled.mockImplementation((catalogId: string, toolId: string) => {
      return catalogId === 'bundled-google' && toolId === 'send_email';
    });

    const result = await handleGetToolDetails(
      { tool_ids: ['gmail__send_email'] },
      catalog,
      registry,
    );

    const parsed = parseResult(result);
    expect(parsed.tools[0].blocked).toBe(true);
    expect(parsed.tools[0].admin_disabled).toBe(true);
    expect(parsed.tools[0].blocked_reason).toContain('administrator');

    mockSecurityPolicy.isAdminDisabled.mockReturnValue(false);
  });

  it('user-disabled tool is annotated correctly', async () => {
    const catalog = createMockCatalog({
      'gmail': [makeToolDef('send_email')],
    });

    mockSecurityPolicy.isUserDisabled.mockImplementation((_pkgId: string, toolId: string) => {
      return toolId === 'send_email';
    });

    const result = await handleGetToolDetails(
      { tool_ids: ['gmail__send_email'] },
      catalog,
      registry,
    );

    const parsed = parseResult(result);
    expect(parsed.tools[0].blocked).toBe(true);
    expect(parsed.tools[0].user_disabled).toBe(true);
    expect(parsed.tools[0].blocked_reason).toBe('Disabled by user');

    mockSecurityPolicy.isUserDisabled.mockReturnValue(false);
  });

  it('mix of found, not_found, and error results in single response', async () => {
    const catalog = createMockCatalog(
      {
        'gmail': [makeToolDef('send_email')],
        'broken': [],
      },
      { 'broken': 'error' },
      { 'broken': 'Server crashed' },
    );

    const result = await handleGetToolDetails(
      { tool_ids: ['gmail__send_email', 'gmail__nonexistent', 'broken__some_tool', 'invalid'] },
      catalog,
      registry,
    );

    const parsed = parseResult(result);
    expect(parsed.tools).toHaveLength(4);

    const found = parsed.tools.find((t: any) => t.tool_id === 'gmail__send_email');
    expect(found.description).toBeTruthy();
    expect(found.schema).toBeDefined();
    expect(found.not_found).toBeUndefined();
    expect(found.error).toBeUndefined();

    const notFound = parsed.tools.find((t: any) => t.tool_id === 'gmail__nonexistent');
    expect(notFound.not_found).toBe(true);

    const errTool = parsed.tools.find((t: any) => t.tool_id === 'broken__some_tool');
    expect(errTool.error).toBe('package_unavailable');
    expect(errTool.description).toContain('Server crashed');

    const invalid = parsed.tools.find((t: any) => t.tool_id === 'invalid');
    expect(invalid.not_found).toBe(true);
    expect(invalid.description).toContain('Invalid tool ID format');
  });

  it('exactly 10 tool_ids is accepted (boundary)', async () => {
    const tools = Array.from({ length: 10 }, (_, i) => makeToolDef(`tool_${i}`));
    const catalog = createMockCatalog({ 'pkg': tools });

    const result = await handleGetToolDetails(
      { tool_ids: tools.map(t => `pkg__${t.name}`) },
      catalog,
      registry,
    );

    const parsed = parseResult(result);
    expect(parsed.tools).toHaveLength(10);
    expect(parsed.tools.every((t: any) => !t.not_found && !t.error)).toBe(true);
  });
});
