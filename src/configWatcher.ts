import * as fs from "fs/promises";
import * as path from "path";
import chokidar, { FSWatcher } from "chokidar";
import { SuperMcpConfig } from "./types.js";
import { SecurityConfig, SecurityPolicy, setSecurityPolicy } from "./security.js";
import { getLogger } from "./logging.js";

const logger = getLogger();

const MAX_CONFIG_DEPTH = 20;
const DEBOUNCE_MS = 500;

export class ConfigWatcher {
  private watcher: FSWatcher | null = null;
  private configPaths: string[];
  private allResolvedPaths: Set<string> = new Set();
  private debounceTimer: NodeJS.Timeout | null = null;

  constructor(configPaths: string[]) {
    this.configPaths = configPaths;
  }

  async start(): Promise<void> {
    await this.discoverAllConfigPaths();
    
    if (this.allResolvedPaths.size === 0) {
      logger.warn("No config files found to watch");
      return;
    }

    const pathsToWatch = Array.from(this.allResolvedPaths);
    
    logger.info("Starting config file watcher", {
      watching: pathsToWatch.length,
      paths: pathsToWatch,
    });

    this.watcher = chokidar.watch(pathsToWatch, {
      persistent: true,
      ignoreInitial: true,
      awaitWriteFinish: {
        stabilityThreshold: 300,
        pollInterval: 100,
      },
    });

    this.watcher.on("change", (changedPath) => {
      logger.debug("Config file change detected", { path: changedPath });
      this.scheduleReload();
    });

    this.watcher.on("error", (error) => {
      logger.error("Config watcher error", {
        error: error instanceof Error ? error.message : String(error),
      });
    });
  }

  async stop(): Promise<void> {
    if (this.debounceTimer) {
      clearTimeout(this.debounceTimer);
      this.debounceTimer = null;
    }
    
    if (this.watcher) {
      await this.watcher.close();
      this.watcher = null;
      logger.info("Config watcher stopped");
    }
  }

  private scheduleReload(): void {
    if (this.debounceTimer) {
      clearTimeout(this.debounceTimer);
    }
    
    this.debounceTimer = setTimeout(async () => {
      this.debounceTimer = null;
      await this.reloadSecurityConfig();
    }, DEBOUNCE_MS);
  }

  private async reloadSecurityConfig(): Promise<void> {
    logger.info("Reloading security configuration...");
    
    try {
      const { securityConfig, userDisabledToolsByServer } = await this.loadMergedConfig();
      const newPolicy = new SecurityPolicy(securityConfig);
      
      // Set user-disabled tools on the new policy
      newPolicy.setUserDisabledTools(userDisabledToolsByServer);
      
      setSecurityPolicy(newPolicy);
      
      const summary = newPolicy.getSummary();
      const userDisabledSummary = newPolicy.getUserDisabledSummary();
      logger.info("Security policy reloaded successfully", {
        ...summary,
        user_disabled_servers: userDisabledSummary.serverCount,
        user_disabled_tools: userDisabledSummary.totalDisabled,
      });
    } catch (error) {
      logger.error("Failed to reload security config, keeping existing policy", {
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }

  private async discoverAllConfigPaths(): Promise<void> {
    this.allResolvedPaths.clear();
    const visited = new Set<string>();

    const discover = async (configPath: string, depth: number): Promise<void> => {
      if (depth > MAX_CONFIG_DEPTH) return;
      
      const normalizedPath = path.resolve(configPath);
      if (visited.has(normalizedPath)) return;
      visited.add(normalizedPath);

      try {
        await fs.access(normalizedPath);
        this.allResolvedPaths.add(normalizedPath);
      } catch {
        return;
      }

      try {
        const configData = await fs.readFile(normalizedPath, "utf8");
        const config: SuperMcpConfig = JSON.parse(configData);

        if (config.configPaths && Array.isArray(config.configPaths)) {
          const baseDir = path.dirname(normalizedPath);
          for (const refPath of config.configPaths) {
            if (typeof refPath === "string" && refPath.trim()) {
              const resolvedRefPath = path.isAbsolute(refPath)
                ? refPath
                : path.resolve(baseDir, refPath);
              await discover(resolvedRefPath, depth + 1);
            }
          }
        }
      } catch {
        // File exists but couldn't be parsed - still watch it
      }
    };

    for (const configPath of this.configPaths) {
      await discover(configPath, 0);
    }
  }

  /**
   * Load merged security config AND user-disabled tools from all config files.
   */
  private async loadMergedConfig(): Promise<{
    securityConfig: SecurityConfig;
    userDisabledToolsByServer: Record<string, string[]>;
  }> {
    const mergedSecurity: SecurityConfig = {};
    const mergedUserDisabled: Record<string, string[]> = {};
    const visited = new Set<string>();

    const loadConfig = async (
      configPath: string,
      depth: number
    ): Promise<void> => {
      if (depth > MAX_CONFIG_DEPTH) return;

      const normalizedPath = path.resolve(configPath);
      if (visited.has(normalizedPath)) return;
      visited.add(normalizedPath);

      let configData: string;
      try {
        configData = await fs.readFile(normalizedPath, "utf8");
      } catch (error: any) {
        if (error.code === "ENOENT") {
          logger.warn("Config file not found during reload", { path: normalizedPath });
        }
        return;
      }

      let config: SuperMcpConfig;
      try {
        config = JSON.parse(configData);
      } catch (error) {
        logger.warn("Invalid JSON in config file during reload", {
          path: normalizedPath,
          error: error instanceof Error ? error.message : String(error),
        });
        throw error;
      }

      // Merge security config
      if (config.security) {
        if (config.security.blockedTools) {
          mergedSecurity.blockedTools = [
            ...(mergedSecurity.blockedTools || []),
            ...config.security.blockedTools,
          ];
        }
        if (config.security.blockedPackages) {
          mergedSecurity.blockedPackages = [
            ...(mergedSecurity.blockedPackages || []),
            ...config.security.blockedPackages,
          ];
        }
        if (config.security.allowedTools) {
          mergedSecurity.allowedTools = [
            ...(mergedSecurity.allowedTools || []),
            ...config.security.allowedTools,
          ];
        }
        if (config.security.allowedPackages) {
          mergedSecurity.allowedPackages = [
            ...(mergedSecurity.allowedPackages || []),
            ...config.security.allowedPackages,
          ];
        }
        if (config.security.logBlockedAttempts !== undefined) {
          mergedSecurity.logBlockedAttempts = config.security.logBlockedAttempts;
        }
      }

      // Merge user-disabled tools by server
      if (config.userDisabledToolsByServer && 
          typeof config.userDisabledToolsByServer === 'object' && 
          !Array.isArray(config.userDisabledToolsByServer)) {
        for (const [serverId, toolNames] of Object.entries(config.userDisabledToolsByServer)) {
          if (!Array.isArray(toolNames)) continue;
          // Filter to valid string tool names
          const validToolNames = toolNames.filter((name): name is string => 
            typeof name === 'string' && name.trim() !== ''
          );
          // Union arrays per server
          const existing = mergedUserDisabled[serverId] || [];
          mergedUserDisabled[serverId] = Array.from(new Set([...existing, ...validToolNames]));
        }
      }

      // Follow configPaths references
      if (config.configPaths && Array.isArray(config.configPaths)) {
        const baseDir = path.dirname(normalizedPath);
        for (const refPath of config.configPaths) {
          if (typeof refPath === "string" && refPath.trim()) {
            const resolvedRefPath = path.isAbsolute(refPath)
              ? refPath
              : path.resolve(baseDir, refPath);
            await loadConfig(resolvedRefPath, depth + 1);
          }
        }
      }
    };

    for (const configPath of this.configPaths) {
      await loadConfig(configPath, 0);
    }

    return {
      securityConfig: mergedSecurity,
      userDisabledToolsByServer: mergedUserDisabled,
    };
  }
}
