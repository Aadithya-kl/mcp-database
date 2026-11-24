import type { Dialect } from "./sql-guard.js";

export type Param = string | number | boolean | null;

export interface Limits {
  /** Maximum number of rows returned to the model. */
  maxRows: number;
  /** Statement timeout in milliseconds (best effort; see README for per-engine notes). */
  timeoutMs: number;
}

export interface TableSummary {
  name: string;
  type: string;
  /** Planner estimate; null when unknown. */
  estimatedRows: number | null;
}

export interface ColumnInfo {
  name: string;
  type: string;
  nullable: boolean;
  default: string | null;
  primaryKey: boolean;
  comment?: string | null;
}

export interface IndexInfo {
  name: string;
  unique: boolean;
  primary: boolean;
  columns: string[];
}

export interface TableDescription {
  schema: string | null;
  table: string;
  columns: ColumnInfo[];
  indexes: IndexInfo[];
  /** Human-readable definitions, e.g. `FOREIGN KEY (user_id) REFERENCES users (id)`. */
  foreignKeys: string[];
}

export interface QueryResult {
  columns: string[];
  rows: unknown[][];
  /** True when more rows existed than `maxRows`. */
  truncated: boolean;
  durationMs: number;
}

export interface ExecuteResult {
  affectedRows: number | null;
  lastInsertId: string | number | null;
  /** Rows produced by RETURNING (capped), if any. */
  returning?: QueryResult;
  durationMs: number;
}

export interface Adapter {
  readonly dialect: Dialect;
  /** Fails fast on bad credentials / unreachable host. */
  ping(): Promise<void>;
  listSchemas(): Promise<string[]>;
  listTables(schema?: string): Promise<TableSummary[]>;
  describeTable(table: string, schema?: string): Promise<TableDescription>;
  /** Runs one read-only statement. The adapter enforces read-only at the connection level. */
  query(sql: string, params: Param[], limits: Limits): Promise<QueryResult>;
  /** Runs one write statement inside a transaction. Only called when writes are enabled. */
  execute(sql: string, params: Param[], limits: Limits): Promise<ExecuteResult>;
  /** Quote an identifier for this dialect. */
  quoteIdent(name: string): string;
  close(): Promise<void>;
}
