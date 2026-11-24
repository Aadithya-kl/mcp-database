import { parseArgs } from "node:util";
import type { Dialect } from "./sql-guard.js";

export interface Config {
  dialect: Dialect;
  /** Connection string (postgres/mysql) or file path / `:memory:` (sqlite). */
  url: string;
  allowWrites: boolean;
  allowDdl: boolean;
  maxRows: number;
  timeoutMs: number;
}

export class ConfigError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ConfigError";
  }
}

export const HELP = `mcp-database — safe MCP server for PostgreSQL, MySQL and SQLite

Usage:
  DATABASE_URL=postgres://user:pass@host/db npx @aranshayan/mcp-database
  npx @aranshayan/mcp-database sqlite:///absolute/path/app.db

Connection (prefer the environment variable; command-line arguments are visible in process lists):
  DATABASE_URL            postgres://…, postgresql://…, mysql://…, mariadb://…, sqlite:///path, or a *.db/*.sqlite file
  --url <url>             same as DATABASE_URL

Safety:
  --read-write            enable the \`execute\` tool (INSERT/UPDATE/DELETE). Default: read-only
  --allow-ddl             with --read-write, also allow CREATE/ALTER/DROP/TRUNCATE
  --max-rows <n>          rows returned per query (default 200, max 5000)
  --timeout-ms <n>        statement timeout in milliseconds (default 15000)

Environment equivalents:
  MCP_DATABASE_READ_WRITE=1  MCP_DATABASE_ALLOW_DDL=1  MCP_DATABASE_MAX_ROWS=…  MCP_DATABASE_TIMEOUT_MS=…

  -h, --help              show this help
  -v, --version           show version
`;

const truthy = (v: string | undefined): boolean => v !== undefined && /^(1|true|yes|on)$/i.test(v.trim());

function intOption(raw: string | undefined, fallback: number, min: number, max: number, label: string): number {
  if (raw === undefined || raw === "") return fallback;
  const n = Number(raw);
  if (!Number.isInteger(n) || n < min || n > max) {
    throw new ConfigError(`${label} must be an integer between ${min} and ${max} (got "${raw}").`);
  }
  return n;
}

export function detectDialect(url: string): { dialect: Dialect; url: string } {
  const lower = url.toLowerCase();
  if (lower.startsWith("postgres://") || lower.startsWith("postgresql://")) return { dialect: "postgres", url };
  if (lower.startsWith("mysql://") || lower.startsWith("mariadb://")) {
    return { dialect: "mysql", url: lower.startsWith("mariadb://") ? `mysql://${url.slice("mariadb://".length)}` : url };
  }
  if (lower.startsWith("sqlite:")) {
    let path = url.slice("sqlite:".length);
    // sqlite:///abs/path -> /abs/path ; sqlite://:memory: -> :memory: ; sqlite:rel.db -> rel.db
    if (path.startsWith("//")) path = path.slice(2);
    if (path === "") throw new ConfigError("sqlite: URL needs a path, e.g. sqlite:///absolute/path/app.db");
    return { dialect: "sqlite", url: path };
  }
  if (/\.(db|sqlite|sqlite3)$/i.test(url) || url === ":memory:") return { dialect: "sqlite", url };
  throw new ConfigError(
    "Unsupported connection string. Use postgres://, mysql://, sqlite:///path or a path ending in .db/.sqlite/.sqlite3.",
  );
}

export function parseConfig(argv: string[], env: NodeJS.ProcessEnv): Config | "help" | "version" {
  const { values, positionals } = parseArgs({
    args: argv,
    allowPositionals: true,
    options: {
      url: { type: "string" },
      "read-write": { type: "boolean", default: false },
      "allow-ddl": { type: "boolean", default: false },
      "max-rows": { type: "string" },
      "timeout-ms": { type: "string" },
      help: { type: "boolean", short: "h", default: false },
      version: { type: "boolean", short: "v", default: false },
    },
  });

  if (values.help) return "help";
  if (values.version) return "version";

  const raw = values.url ?? positionals[0] ?? env.DATABASE_URL ?? env.MCP_DATABASE_URL;
  if (!raw) {
    throw new ConfigError("No database configured. Set DATABASE_URL or pass a connection string. Run with --help for details.");
  }
  const { dialect, url } = detectDialect(raw);

  const allowWrites = values["read-write"] || truthy(env.MCP_DATABASE_READ_WRITE);
  const allowDdl = values["allow-ddl"] || truthy(env.MCP_DATABASE_ALLOW_DDL);
  if (allowDdl && !allowWrites) {
    throw new ConfigError("--allow-ddl requires --read-write.");
  }

  return {
    dialect,
    url,
    allowWrites,
    allowDdl,
    maxRows: intOption(values["max-rows"] ?? env.MCP_DATABASE_MAX_ROWS, 200, 1, 5000, "--max-rows"),
    timeoutMs: intOption(values["timeout-ms"] ?? env.MCP_DATABASE_TIMEOUT_MS, 15_000, 100, 600_000, "--timeout-ms"),
  };
}
