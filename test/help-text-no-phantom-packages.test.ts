import { describe, it, expect, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { getTopicHelp } from '../src/handlers/getHelp.js';

// Suppress logger output during tests
vi.mock('../src/logging.js', () => ({
  getLogger: () => ({
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
  }),
}));

const here = dirname(fileURLToPath(import.meta.url));
const srcRoot = resolve(here, '..', 'src');
const serverSrc = readFileSync(resolve(srcRoot, 'server.ts'), 'utf8');
const getHelpSrc = readFileSync(resolve(srcRoot, 'handlers', 'getHelp.ts'), 'utf8');

/**
 * Regression guard for "help text as capability advertisement" bug.
 *
 * Background:
 *   An agent read super-mcp's `tool_discovery` help topic (and/or the
 *   `list_tools` input-schema `examples` metadata), saw `brave-search`
 *   listed alongside real packages like filesystem/github/notion-api, and
 *   treated that as an inventory claim that the package was available.
 *   The agent then called `list_tools(package_id: "brave-search")`.
 *   Super-mcp's registry correctly returns a clean "Package 'brave-search'
 *   not found in configuration. Available packages: [...]" error — but
 *   the agent paraphrased that to the user as "Brave Search MCP has a
 *   broken install", producing a phantom-broken-connector report even
 *   though the user had never added Brave Search.
 *
 * Rule:
 *   Agent-readable static surfaces (help topic bodies and JSON-schema
 *   `examples` for tool inputs) must not hand-curate package names that
 *   are not part of super-mcp's default seed config. Real examples are
 *   fine when framed as "availability depends on config"; absolute bullet
 *   lists and schema examples must be verifiable-or-removed.
 *
 * If you legitimately need to reference a new package by name in either
 * surface, add it to super-mcp's defaults (see `cli.ts` seeds) and extend
 * this guard's allow list. Otherwise, keep the help text directing agents
 * to run `list_tool_packages()` to discover what's actually configured.
 */
describe('help text does not hallucinate packages', () => {
  it('tool_discovery topic does not name brave-search', () => {
    const help = getTopicHelp('tool_discovery');
    expect(help).not.toMatch(/brave-search/i);
  });

  it('tool_discovery topic tells agents to call list_tool_packages first', () => {
    const help = getTopicHelp('tool_discovery');
    expect(help).toMatch(/list_tool_packages/);
  });

  it('tool_discovery topic frames package bullets as examples, not inventory', () => {
    const help = getTopicHelp('tool_discovery');
    expect(help.toLowerCase()).toMatch(/depend(s)? on (your )?(super-mcp )?config/);
  });

  it('no help topic mentions brave-search (covers every topic registered in getHelp.ts)', () => {
    const topics = [
      'getting_started',
      'workflow',
      'authentication',
      'tool_discovery',
      'error_handling',
      'common_patterns',
      'package_types',
    ];
    for (const topic of topics) {
      expect(getTopicHelp(topic)).not.toMatch(/brave-search/i);
    }
  });

  it('server.ts (tool-registration source) does not advertise brave-search anywhere', () => {
    // Covers the `list_tools` input schema `examples` and any other
    // tool-description / schema metadata agents see when enumerating super-mcp's
    // builtin tools over MCP.
    expect(serverSrc).not.toMatch(/brave-search/i);
  });

  it('handlers/getHelp.ts source does not advertise brave-search anywhere', () => {
    expect(getHelpSrc).not.toMatch(/brave-search/i);
  });
});
