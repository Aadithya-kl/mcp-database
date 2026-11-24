import type { DatabaseSync, SQLInputValue } from "node:sqlite";
import type { Adapter, ExecuteResult, Limits, Param, QueryResult, TableDescription, TableSummary } from "../types.js";
import { toJsonRow } from "../serialize.js";

export interface SqliteOptions {
  path: string;
  writable: boolean;
}

function bind(params: Param[]): SQLInputValue[] {
  return params.map((p) => (typeof p === "boolean" ? (p ? 1 : 0) : p));
}

/**
 * SQLite adapter backed by the built-in `node:sqlite` module (no native addon to compile).
 *
 * Read-only is enforced twice: the file is opened with `readOnly: true`
 * and `PRAGMA query_only = ON` is set. SQLite executes synchronously, so a
 * statement cannot be interrupted by a timeout — the row cap bounds memory instead.
 */
export class SqliteAdapter implements Adapter {
  readonly dialect = "sqlite" as const;

  private constructor(
    private readonly opts: SqliteOptions,
    private readonly db: DatabaseSync,
  ) {}

  /** `node:sqlite` is loaded lazily so PostgreSQL / MySQL users never trigger its experimental-feature warning. */
  static async open(opts: SqliteOptions): Promise<SqliteAdapter> {
    const { DatabaseSync: Database } = await import("node:sqlite");
    const inMemory = opts.path === ":memory:";
    const db = new Database(opts.path, { readOnly: !opts.writable && !inMemory });
    if (!opts.writable) db.exec("PRAGMA query_only = ON");
    return new SqliteAdapter(opts, db);
  }

  async ping(): Promise<void> {
    this.db.prepare("SELECT 1").get();
  }

  quoteIdent(name: string): string {
    return `"${name.replaceAll('"', '""')}"`;
  }

  async listSchemas(): Promise<string[]> {
    const rows = this.db.prepare("SELECT name FROM pragma_database_list ORDER BY seq").all() as Array<{ name: string }>;
    return rows.map((r) => r.name);
  }

  async listTables(schema = "main"): Promise<TableSummary[]> {
    const rows = this.db
      .prepare(
        `SELECT name, type FROM ${this.quoteIdent(schema)}.sqlite_master
         WHERE type IN ('table', 'view') AND name NOT LIKE 'sqlite\\_%' ESCAPE '\\'
         ORDER BY name`,
      )
      .all() as Array<{ name: string; type: string }>;
    return rows.map((r) => ({ name: r.name, type: r.type, estimatedRows: null }));
  }

  async describeTable(table: string, schema = "main"): Promise<TableDescription> {
    const cols = this.db
      .prepare("SELECT name, type, \"notnull\" AS not_null, dflt_value, pk FROM pragma_table_xinfo(?, ?) ORDER BY cid")
      .all(table, schema) as Array<{ name: string; type: string; not_null: number; dflt_value: string | null; pk: number }>;
    if (cols.length === 0) throw new Error(`Table or view "${schema}.${table}" not found.`);

    const indexList = this.db.prepare("SELECT name, \"unique\" AS uniq, origin FROM pragma_index_list(?, ?)").all(table, schema) as Array<{
      name: string;
      uniq: number;
      origin: string;
    }>;
    const indexes = indexList.map((ix) => {
      const info = this.db.prepare("SELECT name FROM pragma_index_info(?, ?) ORDER BY seqno").all(ix.name, schema) as Array<{ name: string | null }>;
      return {
        name: ix.name,
        unique: ix.uniq === 1,
        primary: ix.origin === "pk",
        columns: info.map((c) => c.name ?? "<expression>"),
      };
    });

    const fkRows = this.db
      .prepare('SELECT id, "table" AS ref_table, "from" AS from_col, "to" AS to_col, on_update, on_delete FROM pragma_foreign_key_list(?, ?) ORDER BY id, seq')
      .all(table, schema) as Array<{ id: number; ref_table: string; from_col: string; to_col: string | null; on_update: string; on_delete: string }>;
    const fkById = new Map<number, typeof fkRows>();
    for (const row of fkRows) fkById.set(row.id, [...(fkById.get(row.id) ?? []), row]);
    const foreignKeys = [...fkById.values()].map((group) => {
      const first = group[0]!;
      const cols = group.map((g) => g.from_col).join(", ");
      const refs = group.map((g) => g.to_col ?? "?").join(", ");
      const actions = [
        first.on_update !== "NO ACTION" ? `ON UPDATE ${first.on_update}` : "",
        first.on_delete !== "NO ACTION" ? `ON DELETE ${first.on_delete}` : "",
      ]
        .filter(Boolean)
        .join(" ");
      return `FOREIGN KEY (${cols}) REFERENCES ${first.ref_table} (${refs})${actions ? ` ${actions}` : ""}`;
    });

    return {
      schema,
      table,
      columns: cols.map((c) => ({
        name: c.name,
        type: c.type || "ANY",
        nullable: c.not_null === 0 && c.pk === 0,
        default: c.dflt_value,
        primaryKey: c.pk > 0,
      })),
      indexes,
      foreignKeys,
    };
  }

  async query(sql: string, params: Param[], limits: Limits): Promise<QueryResult> {
    const started = performance.now();
    const stmt = this.db.prepare(sql);
    stmt.setReadBigInts(true);
    // Arrays (not objects) so that duplicate column names such as `a.id, b.id` survive.
    stmt.setReturnArrays(true);
    const columns = stmt.columns().map((c) => c.name);
    const rows: unknown[][] = [];
    let truncated = false;
    for (const row of stmt.iterate(...bind(params)) as Iterable<unknown[]>) {
      if (rows.length >= limits.maxRows) {
        truncated = true;
        break;
      }
      rows.push(toJsonRow(row));
    }
    return { columns, rows, truncated, durationMs: Math.round(performance.now() - started) };
  }

  async execute(sql: string, params: Param[], _limits: Limits): Promise<ExecuteResult> {
    if (!this.opts.writable) throw new Error("Database is opened read-only.");
    const started = performance.now();
    const result = this.db.prepare(sql).run(...bind(params));
    return {
      affectedRows: Number(result.changes),
      lastInsertId: Number(result.lastInsertRowid) || null,
      durationMs: Math.round(performance.now() - started),
    };
  }

  async close(): Promise<void> {
    this.db.close();
  }
}
