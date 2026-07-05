const LEVELS = ["debug", "info", "warn", "error"] as const;
export type LogLevel = (typeof LEVELS)[number];

export interface Logger {
  debug(message: string, meta?: Record<string, unknown>): void;
  info(message: string, meta?: Record<string, unknown>): void;
  warn(message: string, meta?: Record<string, unknown>): void;
  error(message: string, meta?: Record<string, unknown>): void;
}

function levelRank(level: LogLevel): number {
  return LEVELS.indexOf(level);
}

/** Minimum level emitted; controlled via LOG_LEVEL env var, defaults to "info". */
function minLevel(): LogLevel {
  const configured = process.env.LOG_LEVEL as LogLevel | undefined;
  return configured && LEVELS.includes(configured) ? configured : "info";
}

function write(module: string, level: LogLevel, message: string, meta?: Record<string, unknown>): void {
  if (levelRank(level) < levelRank(minLevel())) return;
  const line = `${new Date().toISOString()} [${level.toUpperCase()}] [${module}] ${message}`;
  const out = level === "error" ? console.error : level === "warn" ? console.warn : console.log;
  if (meta && Object.keys(meta).length > 0) {
    out(line, meta);
  } else {
    out(line);
  }
}

/** Creates a logger tagged with a module name, e.g. createLogger("modbus"). */
export function createLogger(module: string): Logger {
  return {
    debug: (message, meta) => write(module, "debug", message, meta),
    info: (message, meta) => write(module, "info", message, meta),
    warn: (message, meta) => write(module, "warn", message, meta),
    error: (message, meta) => write(module, "error", message, meta),
  };
}
