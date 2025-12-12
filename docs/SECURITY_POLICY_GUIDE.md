# Security Policy Guide

Super-MCP provides a layered security model for controlling which tools and packages LLM agents can access. This document explains how to configure security rules using allowlists, blocklists, and pattern matching to enforce fine-grained access control.

## See Also

- [README.md](../README.md) – Quick start guide and basic Super-MCP configuration
- [CONFIGURATION_REFERENCE.md](./CONFIGURATION_REFERENCE.md) – Full configuration schema including all security options
- [`src/security.ts`](../src/security.ts) – SecurityPolicy implementation with pattern matching logic
- [`src/configWatcher.ts`](../src/configWatcher.ts) – Hot-reload implementation for security config changes

---

## Layered Security Model

Super-MCP uses a **layered security model** where both allowlist and blocklist rules apply together. This was changed in v2.2.0 to provide defense-in-depth.

### How It Works

When a tool or package access is requested, it must pass through two gates:

1. **Gate 1 – Allowlist Check**: If an allowlist is configured, the item **must be on it** to proceed
2. **Gate 2 – Blocklist Check**: If a blocklist is configured, the item **must NOT be on it** to be allowed

Both gates are evaluated independently. An item must satisfy *both* constraints (when configured) to be permitted.

### Decision Matrix

| Allowlist | Blocklist | Result |
|-----------|-----------|--------|
| Not configured | Not configured | ✅ Allowed (security disabled) |
| Item matches | Not configured | ✅ Allowed |
| Item matches | Item NOT on blocklist | ✅ Allowed |
| Item matches | Item IS on blocklist | ❌ Blocked by blocklist |
| Not configured | Item NOT on blocklist | ✅ Allowed |
| Not configured | Item IS on blocklist | ❌ Blocked by blocklist |
| Item does NOT match | — | ❌ Blocked by allowlist |

---

## Configuration Options

Add security rules to your Super-MCP config file under the `security` key:

```json
{
  "security": {
    "blockedTools": ["filesystem__delete_file", "/.*destroy.*/i"],
    "blockedPackages": ["dangerous-package"],
    "allowedTools": ["filesystem__read_file", "filesystem__list_directory"],
    "allowedPackages": ["filesystem", "web-search"],
    "logBlockedAttempts": true
  }
}
```

### Option Reference

| Option | Type | Default | Description |
|--------|------|---------|-------------|
| `blockedTools` | `string[]` | `[]` | Tool names or regex patterns to block |
| `blockedPackages` | `string[]` | `[]` | Package IDs to completely block |
| `allowedTools` | `string[]` | `[]` | If set, only these tools are permitted (allowlist mode) |
| `allowedPackages` | `string[]` | `[]` | If set, only these packages are permitted (allowlist mode) |
| `logBlockedAttempts` | `boolean` | `true` | Whether to log blocked access attempts |

---

## Pattern Matching Syntax

Security rules support two matching modes:

### Exact Match

Simply specify the tool or package name as a string:

```json
{
  "blockedTools": ["filesystem__delete_file", "shell__execute"]
}
```

### Regex Pattern

Wrap the pattern in forward slashes with optional flags:

```
/pattern/flags
```

Supported flags: `g`, `i`, `m`, `s`, `u`, `y`

```json
{
  "blockedTools": [
    "/.*delete.*/i",
    "/^shell__.*/",
    "/dangerous/gi"
  ]
}
```

### Namespaced Tool Format

Tools are identified using the format `packageId__toolName` (double underscore separator). For example:

- `filesystem__read_file` – the `read_file` tool from the `filesystem` package
- `shell__execute` – the `execute` tool from the `shell` package

When checking tools, Super-MCP matches against both:
- The full namespaced name (`packageId__toolName`)
- The short tool name alone (`toolName`)

---

## Hot Reload

Security configuration supports hot-reload without restarting Super-MCP.

### How It Works

1. **File Watching**: All config files in the `configPaths` chain are watched via [chokidar](https://github.com/paulmillr/chokidar)
2. **Debouncing**: Changes are debounced with a 500ms delay to handle rapid edits
3. **Fail-Safe**: If the updated config contains invalid JSON, the existing security policy remains in effect
4. **Logging**: Successful reloads log "Security policy reloaded successfully" with a summary

### Watched Files

The watcher automatically discovers and monitors:
- All config files specified in the initial `configPaths`
- Any files referenced via nested `configPaths` in those configs
- Up to 20 levels of nesting (cycle-safe)

---

## Common Security Patterns

### Block All Delete Operations

```json
{
  "security": {
    "blockedTools": ["/.*delete.*/i", "/.*remove.*/i", "/.*destroy.*/i"]
  }
}
```

### Read-Only Filesystem

Allow only safe read operations:

```json
{
  "security": {
    "allowedTools": [
      "filesystem__read_file",
      "filesystem__list_directory",
      "filesystem__get_file_info"
    ]
  }
}
```

### Block an Entire Package

Prevent any tool from a specific package:

```json
{
  "security": {
    "blockedPackages": ["shell", "code-execution"]
  }
}
```

### Allowlist-Only Mode (Maximum Restriction)

Only permit explicitly approved tools:

```json
{
  "security": {
    "allowedPackages": ["filesystem", "web-search"],
    "allowedTools": [
      "filesystem__read_file",
      "filesystem__list_directory",
      "web-search__search"
    ]
  }
}
```

### Defense in Depth (Layered)

Combine allowlist and blocklist for multiple security layers:

```json
{
  "security": {
    "allowedPackages": ["filesystem"],
    "blockedTools": ["/.*delete.*/i", "/.*write.*/i"]
  }
}
```

This allows only the `filesystem` package, then further blocks any destructive operations within it.

---

## Troubleshooting

### Check Blocked Attempt Logs

When a tool or package is blocked, Super-MCP logs:

```
Blocked tool access attempt: {
  type: "tool",
  name: "filesystem__delete_file",
  reason: "Tool 'filesystem__delete_file' is explicitly blocked",
  gate: "blocklist"
}
```

The `gate` field indicates which security layer blocked the request:
- `allowlist` – item was not in the allowed list
- `blocklist` – item matched a blocked pattern

### Verify Pattern Syntax

Common pattern issues:

| Problem | Incorrect | Correct |
|---------|-----------|---------|
| Missing delimiters | `.*delete.*` | `/.*delete.*/` |
| Unescaped special chars | `/filesystem.read/` | `/filesystem\.read/` |
| Case sensitivity | `/DELETE/` | `/DELETE/i` or `/delete/i` |

### Confirm Hot-Reload

After editing config, check logs for:

```
Security policy reloaded successfully: {
  mode: "layered",
  blockedToolCount: 3,
  blockedPackageCount: 1,
  allowedToolCount: 0,
  allowedPackageCount: 2
}
```

If you see "Failed to reload security config, keeping existing policy", check for JSON syntax errors in your config file.

### Debug Security State

The security policy logs its initialization mode:

```
Security policy initialized: {
  mode: "layered" | "allowlist" | "blocklist" | "disabled",
  allowed_tools: 5,
  allowed_packages: 2,
  blocked_tools: 3,
  blocked_packages: 1
}
```

---

## Maintenance

This document should be updated when:
- New security configuration options are added to `src/security.ts`
- The layered security model logic changes
- Pattern matching syntax is extended
- Hot-reload behavior in `src/configWatcher.ts` changes
