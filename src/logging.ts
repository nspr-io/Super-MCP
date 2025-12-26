import * as fs from "fs";
import * as path from "path";

export type LogLevel = "debug" | "info" | "warn" | "error" | "fatal";

export interface LogEntry {
  level: LogLevel;
  msg: string;
  timestamp?: string;
  package_id?: string;
  tool_id?: string;
  request_id?: string;
  [key: string]: any;
}

class Logger {
  private level: LogLevel;
  private levelPriority: Record<LogLevel, number> = {
    debug: 0,
    info: 1,
    warn: 2,
    error: 3,
    fatal: 4,
  };
  private logFile: string;
  private logStream?: fs.WriteStream;

  constructor(level: LogLevel = "info") {
    this.level = level;
    
    // Create logs directory
    const logsDir = path.join(process.env.HOME || "", ".super-mcp", "logs");
    fs.mkdirSync(logsDir, { recursive: true, mode: 0o700 });
    
    // Create log file with timestamp
    const timestamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, -5);
    this.logFile = path.join(logsDir, `super-mcp-${timestamp}.log`);
    
    // Create write stream
    this.logStream = fs.createWriteStream(this.logFile, { flags: 'a', mode: 0o600 });
    
    // Log startup
    this.writeToFile({
      level: "info",
      msg: "===== Super MCP Router Starting =====",
      timestamp: new Date().toISOString(),
      pid: process.pid,
      node_version: process.version,
      platform: process.platform,
      log_file: this.logFile,
    });
    
    // Handle process events
    this.setupProcessHandlers();
    
    // Print log location to console
    console.error(`📝 Logging to: ${this.logFile}`);
  }
  
  private setupProcessHandlers() {
    process.on('uncaughtException', (error) => {
      this.writeToFile({
        level: "fatal",
        msg: "UNCAUGHT EXCEPTION - Server will crash",
        timestamp: new Date().toISOString(),
        error_message: error.message,
        error_stack: error.stack,
        error_name: error.name,
      });
      
      // Ensure log is written before exit
      if (this.logStream) {
        this.logStream.end(() => process.exit(1));
      } else {
        process.exit(1);
      }
    });
    
    process.on('unhandledRejection', (reason, promise) => {
      this.writeToFile({
        level: "error",
        msg: "UNHANDLED REJECTION",
        timestamp: new Date().toISOString(),
        reason: reason instanceof Error ? reason.message : String(reason),
        stack: reason instanceof Error ? reason.stack : undefined,
      });
    });
    
    process.on('exit', (code) => {
      this.writeToFile({
        level: "info",
        msg: `Process exiting with code ${code}`,
        timestamp: new Date().toISOString(),
      });
    });
    
    process.on('SIGINT', () => {
      this.writeToFile({
        level: "info",
        msg: "Received SIGINT",
        timestamp: new Date().toISOString(),
      });
    });
    
    process.on('SIGTERM', () => {
      this.writeToFile({
        level: "info",
        msg: "Received SIGTERM",
        timestamp: new Date().toISOString(),
      });
    });
  }
  
  private writeToFile(entry: any) {
    if (this.logStream && !this.logStream.destroyed) {
      this.logStream.write(JSON.stringify(entry) + '\n');
    }
  }

  setLevel(level: LogLevel) {
    this.level = level;
  }

  private shouldLog(level: LogLevel): boolean {
    return this.levelPriority[level] >= this.levelPriority[this.level];
  }

  private sanitizeData(data: any): any {
    if (typeof data !== "object" || data === null) {
      return data;
    }

    if (Array.isArray(data)) {
      return data.map(item => this.sanitizeData(item));
    }

    const sanitized: any = {};
    for (const [key, value] of Object.entries(data)) {
      // Redact sensitive information
      if (key.toLowerCase().includes("token") || 
          key.toLowerCase().includes("secret") ||
          key.toLowerCase().includes("key") ||
          key.toLowerCase().includes("password")) {
        sanitized[key] = "[REDACTED]";
      } else if (typeof value === "string" && (
          value.includes("Bearer ") ||
          value.includes("access_token") ||
          value.includes("refresh_token"))) {
        sanitized[key] = "[REDACTED]";
      } else {
        sanitized[key] = this.sanitizeData(value);
      }
    }
    return sanitized;
  }

  private log(level: LogLevel, msg: string, data: Record<string, any> = {}) {
    if (!this.shouldLog(level)) {
      return;
    }

    const entry: LogEntry = {
      level,
      msg,
      timestamp: new Date().toISOString(),
      ...this.sanitizeData(data),
    };

    // Write to file
    this.writeToFile(entry);
    
    // Also write to console.error for MCP communication
    console.error(JSON.stringify(entry));
  }

  debug(msg: string, data?: Record<string, any>) {
    this.log("debug", msg, data);
  }

  info(msg: string, data?: Record<string, any>) {
    this.log("info", msg, data);
  }

  warn(msg: string, data?: Record<string, any>) {
    this.log("warn", msg, data);
  }

  error(msg: string, data?: Record<string, any>) {
    this.log("error", msg, data);
  }

  fatal(msg: string, data?: Record<string, any>) {
    this.log("fatal", msg, data);
  }
}

let logger: Logger;

export function initLogger(level: LogLevel = "info"): Logger {
  logger = new Logger(level);
  return logger;
}

export function getLogger(): Logger {
  if (!logger) {
    logger = new Logger();
  }
  return logger;
}