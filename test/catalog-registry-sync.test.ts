import { describe, it, expect, vi, beforeEach } from 'vitest';
import { handleHealthCheckPackage } from '../src/handlers/healthCheckPackage.js';
import { handleHealthCheckAll } from '../src/handlers/healthCheck.js';
import { handleRestartPackage } from '../src/handlers/restartPackage.js';
import { handleAuthenticate } from '../src/handlers/authenticate.js';
import { handleListToolPackages } from '../src/handlers/listToolPackages.js';
import { handleReadResource } from '../src/handlers/readResource.js';
import type { Catalog } from '../src/catalog.js';
import type { PackageRegistry } from '../src/registry.js';
import type { McpClient, PackageConfig } from '../src/types.js';

// Suppress logger output during tests
vi.mock('../src/logging.js', () => ({
  getLogger: () => ({
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
  }),
}));

// Mock portFinder to avoid real port scanning in authenticate tests
vi.mock('../src/utils/portFinder.js', () => ({
  findAvailablePort: vi.fn().mockResolvedValue(5173),
  checkPortAvailable: vi.fn().mockResolvedValue(true),
}));

// Mock formatError used by authenticate handler
vi.mock('../src/utils/formatError.js', () => ({
  formatError: (e: unknown) => (e instanceof Error ? e.message : String(e)),
}));

/** Create a mock Catalog with configurable per-package status. */
function createMockCatalog(statusMap: Record<string, string> = {}): Catalog {
  return {
    getPackageStatus: vi.fn((id: string) => statusMap[id] ?? 'unknown'),
    clearPackage: vi.fn(),
    ensurePackageLoaded: vi.fn().mockResolvedValue(undefined),
    countTools: vi.fn().mockReturnValue(3),
    buildPackageSummary: vi.fn().mockResolvedValue('mock summary'),
    etag: vi.fn().mockReturnValue('etag-1'),
    getPackageError: vi.fn().mockReturnValue(undefined),
    getPackageForResourceUri: vi.fn().mockReturnValue(undefined),
    getKnownResourcePrefixes: vi.fn().mockReturnValue([]),
  } as unknown as Catalog;
}

/** Create a mock McpClient with optional overrides. */
function createMockClient(overrides: Partial<McpClient> = {}): McpClient {
  return {
    connect: vi.fn().mockResolvedValue(undefined),
    listTools: vi.fn().mockResolvedValue([]),
    callTool: vi.fn().mockResolvedValue({ content: [] }),
    close: vi.fn().mockResolvedValue(undefined),
    healthCheck: vi.fn().mockResolvedValue('ok'),
    requiresAuth: vi.fn().mockResolvedValue(false),
    isAuthenticated: vi.fn().mockResolvedValue(true),
    readResource: vi.fn().mockResolvedValue({ contents: [{ uri: 'test://r', text: 'data' }] }),
    hasPendingRequests: vi.fn().mockReturnValue(false),
    ...overrides,
  };
}

/** Create a mock PackageRegistry with configurable behavior. */
function createMockRegistry(overrides: {
  healthCheck?: (id: string) => Promise<'ok' | 'error' | 'unavailable'>;
  getClient?: (id: string) => Promise<McpClient>;
  getPackage?: (id: string) => PackageConfig | undefined;
  getPackages?: (opts?: { safe_only?: boolean }) => PackageConfig[];
  restartPackage?: (id: string) => Promise<{ success: boolean; message: string }>;
} = {}): PackageRegistry {
  const defaultPkg: PackageConfig = {
    id: 'test-pkg',
    name: 'Test Package',
    transport: 'http',
    base_url: 'http://localhost:3000',
    visibility: 'default',
  };
  return {
    healthCheck: overrides.healthCheck ?? vi.fn().mockResolvedValue('ok'),
    getClient: overrides.getClient ?? vi.fn().mockResolvedValue(createMockClient()),
    getPackage: overrides.getPackage ?? vi.fn().mockReturnValue(defaultPkg),
    getPackages: overrides.getPackages ?? vi.fn().mockReturnValue([defaultPkg]),
    restartPackage: overrides.restartPackage ?? vi.fn().mockResolvedValue({ success: true, message: 'restarted' }),
  } as unknown as PackageRegistry;
}

// ---------------------------------------------------------------------------
// health_check handler
// ---------------------------------------------------------------------------

describe('Catalog-Registry sync: health_check handler', () => {
  it('clears catalog when catalog="error" and health="ok"', async () => {
    const catalog = createMockCatalog({ 'test-pkg': 'error' });
    const registry = createMockRegistry();

    await handleHealthCheckPackage({ package_id: 'test-pkg' }, registry, catalog);

    expect(catalog.clearPackage).toHaveBeenCalledWith('test-pkg');
  });

  it('clears catalog when catalog="auth_required" and health="ok"', async () => {
    const catalog = createMockCatalog({ 'test-pkg': 'auth_required' });
    const registry = createMockRegistry();

    await handleHealthCheckPackage({ package_id: 'test-pkg' }, registry, catalog);

    expect(catalog.clearPackage).toHaveBeenCalledWith('test-pkg');
  });

  it('does NOT clear catalog when catalog="ready" and health="ok"', async () => {
    const catalog = createMockCatalog({ 'test-pkg': 'ready' });
    const registry = createMockRegistry();

    await handleHealthCheckPackage({ package_id: 'test-pkg' }, registry, catalog);

    expect(catalog.clearPackage).not.toHaveBeenCalled();
  });

  it('does NOT clear catalog when catalog="error" and health="error"', async () => {
    const catalog = createMockCatalog({ 'test-pkg': 'error' });
    const registry = createMockRegistry({
      healthCheck: vi.fn().mockResolvedValue('error'),
    });

    await handleHealthCheckPackage({ package_id: 'test-pkg' }, registry, catalog);

    expect(catalog.clearPackage).not.toHaveBeenCalled();
  });

  it('does NOT clear catalog when catalog="unknown" and health="ok"', async () => {
    const catalog = createMockCatalog({}); // unknown by default
    const registry = createMockRegistry();

    await handleHealthCheckPackage({ package_id: 'test-pkg' }, registry, catalog);

    expect(catalog.clearPackage).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// health_check_all handler
// ---------------------------------------------------------------------------

describe('Catalog-Registry sync: health_check_all handler', () => {
  it('clears only the stale-error package, not the ready one', async () => {
    const pkgA: PackageConfig = {
      id: 'pkg-a',
      name: 'Package A',
      transport: 'http',
      base_url: 'http://localhost:3001',
      visibility: 'default',
    };
    const pkgB: PackageConfig = {
      id: 'pkg-b',
      name: 'Package B',
      transport: 'http',
      base_url: 'http://localhost:3002',
      visibility: 'default',
    };

    const catalog = createMockCatalog({ 'pkg-a': 'error', 'pkg-b': 'ready' });
    const registry = createMockRegistry({
      healthCheck: vi.fn().mockResolvedValue('ok'),
      getPackages: vi.fn().mockReturnValue([pkgA, pkgB]),
      getClient: vi.fn().mockResolvedValue(createMockClient()),
    });

    await handleHealthCheckAll({ detailed: false }, registry, catalog);

    expect(catalog.clearPackage).toHaveBeenCalledWith('pkg-a');
    expect(catalog.clearPackage).not.toHaveBeenCalledWith('pkg-b');
  });
});

// ---------------------------------------------------------------------------
// restart_package handler
// ---------------------------------------------------------------------------

describe('Catalog-Registry sync: restart_package handler', () => {
  it('clears catalog when restart succeeds and catalog="error"', async () => {
    const catalog = createMockCatalog({ 'test-pkg': 'error' });
    const registry = createMockRegistry({
      restartPackage: vi.fn().mockResolvedValue({ success: true, message: 'restarted' }),
    });

    await handleRestartPackage({ package_id: 'test-pkg' }, registry, catalog);

    expect(catalog.clearPackage).toHaveBeenCalledWith('test-pkg');
  });

  it('does NOT clear catalog when restart fails', async () => {
    const catalog = createMockCatalog({ 'test-pkg': 'error' });
    const registry = createMockRegistry({
      restartPackage: vi.fn().mockResolvedValue({ success: false, message: 'failed' }),
    });

    await handleRestartPackage({ package_id: 'test-pkg' }, registry, catalog);

    expect(catalog.clearPackage).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// authenticate handler
// ---------------------------------------------------------------------------

describe('Catalog-Registry sync: authenticate handler', () => {
  it('clears catalog on already_authenticated when catalog="error"', async () => {
    const catalog = createMockCatalog({ 'test-pkg': 'error' });
    const client = createMockClient({
      healthCheck: vi.fn().mockResolvedValue('ok'),
      listTools: vi.fn().mockResolvedValue([{ name: 'tool1' }]),
    });
    const registry = createMockRegistry({
      getClient: vi.fn().mockResolvedValue(client),
      getPackage: vi.fn().mockReturnValue({
        id: 'test-pkg',
        name: 'Test',
        transport: 'http',
        base_url: 'http://localhost:3000',
        visibility: 'default',
      }),
    });

    const result = await handleAuthenticate(
      { package_id: 'test-pkg', wait_for_completion: false },
      registry,
      catalog,
    );

    const parsed = JSON.parse(result.content[0].text);
    expect(parsed.status).toBe('already_authenticated');
    expect(catalog.clearPackage).toHaveBeenCalledWith('test-pkg');
  });

  it('does NOT clear catalog when getClient throws (auth failure)', async () => {
    const catalog = createMockCatalog({ 'test-pkg': 'error' });
    const registry = createMockRegistry({
      getClient: vi.fn().mockRejectedValue(new Error('connection failed')),
      getPackage: vi.fn().mockReturnValue({
        id: 'test-pkg',
        name: 'Test',
        transport: 'http',
        base_url: 'http://localhost:3000',
        visibility: 'default',
      }),
    });

    // When getClient throws AND the subsequent OAuth flow also fails,
    // catalog should NOT be cleared
    const result = await handleAuthenticate(
      { package_id: 'test-pkg', wait_for_completion: false },
      registry,
      catalog,
    );

    const parsed = JSON.parse(result.content[0].text);
    // Status will be auth_required or error since client isn't healthy
    expect(parsed.status).not.toBe('already_authenticated');
    expect(parsed.status).not.toBe('authenticated');
    expect(catalog.clearPackage).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// list_tool_packages handler
// ---------------------------------------------------------------------------

describe('Catalog-Registry sync: list_tool_packages handler', () => {
  it('clears catalog and re-fetches when health="ok" and catalog="error"', async () => {
    const catalog = createMockCatalog({ 'test-pkg': 'error' });
    const registry = createMockRegistry({
      healthCheck: vi.fn().mockResolvedValue('ok'),
    });

    await handleListToolPackages(
      { safe_only: true, limit: 100, include_health: true },
      registry,
      catalog,
    );

    expect(catalog.clearPackage).toHaveBeenCalledWith('test-pkg');
    // After clearing, ensurePackageLoaded should be called again for re-fetch
    // First call is the initial load, second is the re-fetch after clear
    expect(catalog.ensurePackageLoaded).toHaveBeenCalledTimes(2);
  });
});

// ---------------------------------------------------------------------------
// readResource handler
// ---------------------------------------------------------------------------

describe('Catalog-Registry sync: readResource handler', () => {
  it('clears catalog after successful readResource when catalog="error"', async () => {
    const catalog = createMockCatalog({ 'test-pkg': 'error' });
    (catalog.getPackageForResourceUri as ReturnType<typeof vi.fn>).mockReturnValue('test-pkg');

    const client = createMockClient({
      readResource: vi.fn().mockResolvedValue({ contents: [{ uri: 'test://r', text: 'data' }] }),
    });
    const registry = createMockRegistry({
      getClient: vi.fn().mockResolvedValue(client),
    });

    await handleReadResource({ uri: 'test://r' }, registry, catalog);

    expect(catalog.clearPackage).toHaveBeenCalledWith('test-pkg');
  });

  it('does NOT clear catalog when readResource fails', async () => {
    const catalog = createMockCatalog({ 'test-pkg': 'error' });
    (catalog.getPackageForResourceUri as ReturnType<typeof vi.fn>).mockReturnValue('test-pkg');

    const client = createMockClient({
      readResource: vi.fn().mockRejectedValue(new Error('upstream failure')),
    });
    const registry = createMockRegistry({
      getClient: vi.fn().mockResolvedValue(client),
    });

    await expect(
      handleReadResource({ uri: 'test://r' }, registry, catalog),
    ).rejects.toMatchObject({ message: expect.stringContaining('upstream failure') });

    expect(catalog.clearPackage).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// Integration-style: full flow from stale error to recovery
// ---------------------------------------------------------------------------

describe('Catalog-Registry sync: integration flow', () => {
  it('health_check clears stale catalog error so subsequent reads see fresh state', async () => {
    // Simulates: catalog has stale "error" → health_check returns "ok" → catalog cleared
    // → next ensurePackageLoaded triggers refresh (no stale cache blocking)
    let currentStatus = 'error';
    const catalog = {
      getPackageStatus: vi.fn(() => currentStatus),
      clearPackage: vi.fn(() => { currentStatus = 'unknown'; }),
      ensurePackageLoaded: vi.fn().mockResolvedValue(undefined),
      countTools: vi.fn().mockReturnValue(5),
      buildPackageSummary: vi.fn().mockResolvedValue('summary'),
      etag: vi.fn().mockReturnValue('etag'),
      getPackageError: vi.fn().mockReturnValue(undefined),
      getPackageForResourceUri: vi.fn(),
      getKnownResourcePrefixes: vi.fn().mockReturnValue([]),
    } as unknown as Catalog;

    const registry = createMockRegistry({
      healthCheck: vi.fn().mockResolvedValue('ok'),
    });

    // Step 1: health_check returns "ok" → clears stale catalog
    await handleHealthCheckPackage({ package_id: 'test-pkg' }, registry, catalog);
    expect(catalog.clearPackage).toHaveBeenCalledWith('test-pkg');

    // Step 2: After clear, catalog status is no longer "error"
    expect(currentStatus).toBe('unknown');

    // Step 3: Next ensurePackageLoaded would trigger a fresh refresh
    // (catalog has no cached entry → calls refreshPackage)
    // Verify the catalog is in a state where it would re-fetch
    expect(catalog.getPackageStatus('test-pkg')).not.toBe('error');
  });
});
