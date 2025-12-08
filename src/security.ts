import { getLogger } from "./logging.js";

const logger = getLogger();

export interface SecurityConfig {
  // Blocklist mode (default): block tools/packages that match
  blockedTools?: string[];      // Exact names or regex patterns like "/.*delete.*/i"
  blockedPackages?: string[];   // Package IDs to completely block
  
  // Allowlist mode: only allow tools/packages that match (if set, blocklist is ignored)
  allowedTools?: string[];      // If set, only these tools are allowed
  allowedPackages?: string[];   // If set, only these packages are allowed
  
  // Logging
  logBlockedAttempts?: boolean; // Log when tools are blocked (default: true)
}

export interface BlockCheckResult {
  blocked: boolean;
  reason?: string;
}

interface CompiledPattern {
  original: string;
  regex: RegExp;
  isRegex: boolean;
}

export class SecurityPolicy {
  private config: SecurityConfig;
  private blockedToolPatterns: CompiledPattern[] = [];
  private blockedPackagePatterns: CompiledPattern[] = [];
  private allowedToolPatterns: CompiledPattern[] = [];
  private allowedPackagePatterns: CompiledPattern[] = [];
  private useAllowlist: boolean = false;

  constructor(config: SecurityConfig = {}) {
    this.config = config;
    this.compilePatterns();
  }

  private compilePatterns(): void {
    // Determine mode: allowlist takes precedence if any allowed* fields are set
    this.useAllowlist = !!(
      (this.config.allowedTools && this.config.allowedTools.length > 0) ||
      (this.config.allowedPackages && this.config.allowedPackages.length > 0)
    );

    if (this.useAllowlist) {
      this.allowedToolPatterns = this.compilePatternList(this.config.allowedTools || []);
      this.allowedPackagePatterns = this.compilePatternList(this.config.allowedPackages || []);
      logger.info("Security policy initialized in ALLOWLIST mode", {
        allowed_tools: this.config.allowedTools?.length || 0,
        allowed_packages: this.config.allowedPackages?.length || 0,
      });
    } else {
      this.blockedToolPatterns = this.compilePatternList(this.config.blockedTools || []);
      this.blockedPackagePatterns = this.compilePatternList(this.config.blockedPackages || []);
      logger.info("Security policy initialized in BLOCKLIST mode", {
        blocked_tools: this.config.blockedTools?.length || 0,
        blocked_packages: this.config.blockedPackages?.length || 0,
      });
    }
  }

  private compilePatternList(patterns: string[]): CompiledPattern[] {
    const compiled: CompiledPattern[] = [];

    for (const pattern of patterns) {
      try {
        const parsed = this.parsePattern(pattern);
        compiled.push(parsed);
      } catch (error) {
        logger.error("Invalid security pattern, skipping", {
          pattern,
          error: error instanceof Error ? error.message : String(error),
        });
      }
    }

    return compiled;
  }

  private parsePattern(pattern: string): CompiledPattern {
    // Check if it's a regex pattern: /pattern/flags
    const regexMatch = pattern.match(/^\/(.+)\/([gimsuy]*)$/);
    
    if (regexMatch) {
      const [, regexBody, flags] = regexMatch;
      return {
        original: pattern,
        regex: new RegExp(regexBody, flags),
        isRegex: true,
      };
    }
    
    // Exact match - escape special regex characters and match exactly
    const escaped = pattern.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    return {
      original: pattern,
      regex: new RegExp(`^${escaped}$`),
      isRegex: false,
    };
  }

  private matchesAnyPattern(value: string, patterns: CompiledPattern[]): CompiledPattern | null {
    for (const pattern of patterns) {
      if (pattern.regex.test(value)) {
        return pattern;
      }
    }
    return null;
  }

  /**
   * Check if a package is blocked.
   * @param packageId The package ID to check
   * @returns BlockCheckResult with blocked status and reason
   */
  isPackageBlocked(packageId: string): BlockCheckResult {
    if (this.useAllowlist) {
      // In allowlist mode: block if NOT in allowed list
      if (this.allowedPackagePatterns.length === 0) {
        // No package allowlist means all packages allowed
        return { blocked: false };
      }
      
      const match = this.matchesAnyPattern(packageId, this.allowedPackagePatterns);
      if (!match) {
        const result: BlockCheckResult = {
          blocked: true,
          reason: `Package '${packageId}' is not in the allowed packages list`,
        };
        this.logBlockedAttempt("package", packageId, result.reason!);
        return result;
      }
      return { blocked: false };
    } else {
      // In blocklist mode: block if in blocked list
      const match = this.matchesAnyPattern(packageId, this.blockedPackagePatterns);
      if (match) {
        const result: BlockCheckResult = {
          blocked: true,
          reason: match.isRegex
            ? `Package '${packageId}' blocked by pattern: ${match.original}`
            : `Package '${packageId}' is explicitly blocked`,
        };
        this.logBlockedAttempt("package", packageId, result.reason!);
        return result;
      }
      return { blocked: false };
    }
  }

  /**
   * Check if a tool is blocked.
   * @param packageId The package ID
   * @param toolId The tool ID (without namespace prefix)
   * @returns BlockCheckResult with blocked status and reason
   */
  isToolBlocked(packageId: string, toolId: string): BlockCheckResult {
    // First check if the entire package is blocked
    const packageCheck = this.isPackageBlocked(packageId);
    if (packageCheck.blocked) {
      return packageCheck;
    }

    // Build the fully qualified tool name for matching
    const fullToolName = `${packageId}__${toolId}`;

    if (this.useAllowlist) {
      // In allowlist mode: block if NOT in allowed list
      if (this.allowedToolPatterns.length === 0) {
        // No tool allowlist means all tools allowed (package already checked)
        return { blocked: false };
      }
      
      // Check both the full name and just the tool name
      const matchFull = this.matchesAnyPattern(fullToolName, this.allowedToolPatterns);
      const matchShort = this.matchesAnyPattern(toolId, this.allowedToolPatterns);
      
      if (!matchFull && !matchShort) {
        const result: BlockCheckResult = {
          blocked: true,
          reason: `Tool '${fullToolName}' is not in the allowed tools list`,
        };
        this.logBlockedAttempt("tool", fullToolName, result.reason!);
        return result;
      }
      return { blocked: false };
    } else {
      // In blocklist mode: block if in blocked list
      // Check both the full name and just the tool name
      const matchFull = this.matchesAnyPattern(fullToolName, this.blockedToolPatterns);
      const matchShort = this.matchesAnyPattern(toolId, this.blockedToolPatterns);
      const match = matchFull || matchShort;
      
      if (match) {
        const result: BlockCheckResult = {
          blocked: true,
          reason: match.isRegex
            ? `Tool '${fullToolName}' blocked by pattern: ${match.original}`
            : `Tool '${fullToolName}' is explicitly blocked`,
        };
        this.logBlockedAttempt("tool", fullToolName, result.reason!);
        return result;
      }
      return { blocked: false };
    }
  }

  private logBlockedAttempt(type: "tool" | "package", name: string, reason: string): void {
    if (this.config.logBlockedAttempts !== false) {
      logger.warn(`Blocked ${type} access attempt`, {
        type,
        name,
        reason,
        mode: this.useAllowlist ? "allowlist" : "blocklist",
      });
    }
  }

  /**
   * Get the security configuration.
   */
  getConfig(): SecurityConfig {
    return { ...this.config };
  }

  /**
   * Check if security is enabled (any rules configured).
   */
  isEnabled(): boolean {
    return (
      (this.config.blockedTools?.length ?? 0) > 0 ||
      (this.config.blockedPackages?.length ?? 0) > 0 ||
      (this.config.allowedTools?.length ?? 0) > 0 ||
      (this.config.allowedPackages?.length ?? 0) > 0
    );
  }

  /**
   * Get a summary of the security policy for logging/debugging.
   */
  getSummary(): {
    mode: "blocklist" | "allowlist" | "disabled";
    blockedToolCount: number;
    blockedPackageCount: number;
    allowedToolCount: number;
    allowedPackageCount: number;
  } {
    if (!this.isEnabled()) {
      return {
        mode: "disabled",
        blockedToolCount: 0,
        blockedPackageCount: 0,
        allowedToolCount: 0,
        allowedPackageCount: 0,
      };
    }

    return {
      mode: this.useAllowlist ? "allowlist" : "blocklist",
      blockedToolCount: this.blockedToolPatterns.length,
      blockedPackageCount: this.blockedPackagePatterns.length,
      allowedToolCount: this.allowedToolPatterns.length,
      allowedPackageCount: this.allowedPackagePatterns.length,
    };
  }
}

// Singleton instance - will be set by registry
let securityPolicy: SecurityPolicy | null = null;

export function setSecurityPolicy(policy: SecurityPolicy): void {
  securityPolicy = policy;
}

export function getSecurityPolicy(): SecurityPolicy {
  if (!securityPolicy) {
    // Return a no-op policy if not initialized
    securityPolicy = new SecurityPolicy({});
  }
  return securityPolicy;
}
