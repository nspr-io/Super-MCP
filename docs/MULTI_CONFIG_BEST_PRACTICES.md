# Multi-Config Best Practices

Best practices for organizing MCP configuration across multiple files.

## See Also

- [README.md](../README.md) — Multiple config basics and getting started
- [CONFIGURATION_REFERENCE.md](./CONFIGURATION_REFERENCE.md) — Full schema reference
- [src/registry.ts](../src/registry.ts) — Config merging logic implementation

---

## Why Use Multiple Configs

Splitting your MCP configuration across multiple files provides several benefits:

- **Separate personal vs work MCPs** — Keep personal tools separate from team-shared configurations
- **Share team-wide configs** — Maintain a shared config that team members reference via `configPaths`
- **Organize by functionality** — Group related servers (dev tools, databases, AI services) together
- **Keep secrets separate** — Store sensitive API keys in a gitignored file

---

## Methods to Specify Multiple Configs

### Multiple `--config` Flags

Pass multiple config files on the command line:

```bash
super-mcp --config ~/.super-mcp/base.json --config ~/.super-mcp/work.json
```

### Environment Variable

Use `SUPER_MCP_CONFIG` with comma-separated paths:

```bash
export SUPER_MCP_CONFIG="~/.super-mcp/base.json,~/.super-mcp/work.json"
super-mcp
```

### configPaths Array

Reference other config files from within a config file:

```json
{
  "configPaths": [
    "./servers/dev-tools.json",
    "./servers/databases.json",
    "/shared/team-config.json"
  ],
  "mcpServers": {
    "local-server": {
      "command": "node",
      "args": ["server.js"]
    }
  }
}
```

**Path resolution:** Relative paths are resolved from the containing config file's directory.

---

## Config Merging Behavior

When loading multiple config files, Super-MCP merges them according to these rules:

### Server Merging

- Servers are merged by ID
- **Last wins**: If the same server ID appears in multiple files, the later config overrides (with a warning logged)
- All servers from all files are combined into a single registry

### Security Rules

- Security arrays are **concatenated** (not replaced):
  - `blockedTools`
  - `blockedPackages`
  - `allowedTools`
  - `allowedPackages`
- Boolean settings like `logBlockedAttempts` use the latest value

### Safety Limits

- **Maximum depth**: 20 levels of nested `configPaths` references
- **Circular reference detection**: Attempting to load a config that's already in the load chain throws an error

---

## Organization Strategies

### By Environment

Separate configurations for different contexts:

```
~/.super-mcp/
├── base.json          # Shared across all environments
├── personal.json      # Personal productivity tools
└── work.json          # Work-specific servers
```

**Usage:**
```bash
super-mcp --config ~/.super-mcp/base.json --config ~/.super-mcp/personal.json
# or for work:
super-mcp --config ~/.super-mcp/base.json --config ~/.super-mcp/work.json
```

### By Function

Group servers by what they do:

```
~/.super-mcp/
├── dev-tools.json     # filesystem, github, git
├── ai-services.json   # search, LLM integrations
└── databases.json     # PostgreSQL, MongoDB connections
```

**With configPaths:**
```json
{
  "configPaths": [
    "./dev-tools.json",
    "./ai-services.json",
    "./databases.json"
  ]
}
```

### By Security Level

Separate configs based on sensitivity:

```
~/.super-mcp/
├── public.json        # Safe to commit, no secrets
├── private.json       # Contains API keys (gitignored)
└── security.json      # Security rules only
```

**Example `.gitignore`:**
```
private.json
```

---

## Best Practices

1. **Keep secrets in a separate file** — Create a dedicated file for configs with API keys and add it to `.gitignore`

2. **Use `configPaths` for shared team configs** — Point to a shared file that all team members reference, making updates automatic

3. **Document file relationships** — Add comments or a README explaining which files exist and their purpose

4. **Test with `health_check_all()` after changes** — Verify all servers are reachable after modifying config files:
   ```
   health_check_all(detailed: true)
   ```

5. **Start with a simple structure** — Begin with 2-3 files and only add complexity when needed

---

## Common Pitfalls

### Circular configPaths References

**Problem:** Config A references Config B, which references Config A.

```json
// a.json
{ "configPaths": ["./b.json"] }

// b.json
{ "configPaths": ["./a.json"] }  // ERROR: Circular reference
```

**Solution:** Structure configs as a tree (parent → children), not a graph.

### Duplicate Server IDs

**Problem:** Same server ID in multiple files causes unexpected behavior.

```json
// file1.json
{ "mcpServers": { "github": { "command": "npx", "args": ["..."] } } }

// file2.json  
{ "mcpServers": { "github": { "command": "node", "args": ["..."] } } }
// WARNING: Last definition wins
```

**Solution:** Use unique, descriptive IDs like `github-personal` and `github-work`.

### Relative Path Resolution

**Problem:** Relative paths in `configPaths` are resolved from the config file's directory, not the current working directory.

```json
// ~/.super-mcp/main.json
{
  "configPaths": ["./servers/dev.json"]  // Resolves to ~/.super-mcp/servers/dev.json
}
```

**Solution:** Use absolute paths when the relationship isn't clear, or keep related configs in the same directory tree.

---

## Maintenance

This document should be updated when changes are made to:
- `src/registry.ts` — Config loading and merging logic
- `src/types.ts` — Configuration type definitions
