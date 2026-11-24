import pg from "pg";
import Cursor from "pg-cursor";
import type { Adapter, ExecuteResult, Limits, Param, QueryResult, TableDescription, TableSummary } from "../types.js";
import { toJsonRow } from "../serialize.js";

export interface PostgresOptions {
  url: string;
  /** Connection pool size (default 3). */
  poolSize?: number;
}

const int = (n: number): number => Math.max(0, Math.trunc(n));

interface CursorWithResult {
  _result?: { fields?: Array<{ name: string }> };
}

/**
 * PostgreSQL adapter.
 *
 * Every query runs inside `BEGIN READ ONLY` with `SET LOCAL statement_timeout`, and rows are
 * pulled through a server-side cursor so a huge result set never has to fit in memory.
 */
export class PostgresAdapter implements Adapter {
  readonly dialect = "postgres" as const;
  private readonly pool: pg.Pool;

  constructor(opts: PostgresOptions) {
    this.pool = new pg.Pool({
      connectionString: opts.url,
      max: opts.poolSize ?? 3,
      application_name: "mcp-database",
      connectionTimeoutMillis: 10_000,
      idleTimeoutMillis: 30_000,
    });
    // An idle client erroring must not crash the process.
    this.pool.on("error", () => {});
  }

  async ping(): Promise<void> {
    await this.pool.query("SELECT 1");
  }

  quoteIdent(name: string): string {
    return `"${name.replaceAll('"', '""')}"`;
  }

  private async rows<T extends pg.QueryResultRow>(text: string, values: unknown[] = []): Promise<T[]> {
    const client = await this.pool.connect();
    try {
      await client.query("BEGIN READ ONLY");
      const res = await client.query<T>(text, values);
      return res.rows;
    } finally {
      await client.query("ROLLBACK").catch(() => {});
      client.release();
    }
  }

  async listSchemas(): Promise<string[]> {
    const rows = await this.rows<{ schema_name: string }>(
      `SELECT schema_name FROM information_schema.schemata
       WHERE schema_name NOT IN ('pg_catalog', 'information_schema')
         AND schema_name NOT LIKE 'pg\\_toast%' AND schema_name NOT LIKE 'pg\\_temp%'
       ORDER BY schema_name`,
    );
    return rows.map((r) => r.schema_name);
  }

  async listTables(schema?: string): Promise<TableSummary[]> {
    const rows = await this.rows<{ name: string; type: string; estimated_rows: string | null }>(
      `SELECT c.relname AS name,
              CASE c.relkind WHEN 'r' THEN 'table' WHEN 'v' THEN 'view' WHEN 'm' THEN 'materialized_view'
                             WHEN 'p' THEN 'partitioned_table' WHEN 'f' THEN 'foreign_table' END AS type,
              CASE WHEN c.reltuples >= 0 THEN c.reltuples::bigint::text END AS estimated_rows
         FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
        WHERE n.nspname = COALESCE($1::text, current_schema()) AND c.relkind IN ('r', 'v', 'm', 'p', 'f')
        ORDER BY c.relname`,
      [schema ?? null],
    );
    return rows.map((r) => ({
      name: r.name,
      type: r.type,
      estimatedRows: r.estimated_rows === null ? null : Number(r.estimated_rows),
    }));
  }

  async describeTable(table: string, schema?: string): Promise<TableDescription> {
    const sch = schema ?? null;
    const columns = await this.rows<{ name: string; type: string; nullable: boolean; default: string | null; comment: string | null }>(
      `SELECT a.attname AS name,
              format_type(a.atttypid, a.atttypmod) AS type,
              NOT a.attnotnull AS nullable,
              pg_get_expr(d.adbin, d.adrelid) AS "default",
              col_description(a.attrelid, a.attnum) AS comment
         FROM pg_attribute a
         JOIN pg_class c ON c.oid = a.attrelid
         JOIN pg_namespace n ON n.oid = c.relnamespace
         LEFT JOIN pg_attrdef d ON d.adrelid = a.attrelid AND d.adnum = a.attnum
        WHERE n.nspname = COALESCE($1::text, current_schema()) AND c.relname = $2
          AND a.attnum > 0 AND NOT a.attisdropped
        ORDER BY a.attnum`,
      [sch, table],
    );
    if (columns.length === 0) throw new Error(`Table or view "${schema ?? "current schema"}.${table}" not found.`);

    const indexes = await this.rows<{ name: string; unique: boolean; primary: boolean; columns: string[] }>(
      `SELECT i.relname AS name, ix.indisunique AS "unique", ix.indisprimary AS "primary",
              ARRAY(SELECT pg_get_indexdef(ix.indexrelid, k + 1, true)
                      FROM generate_subscripts(ix.indkey, 1) AS k ORDER BY k) AS columns
         FROM pg_index ix
         JOIN pg_class i ON i.oid = ix.indexrelid
         JOIN pg_class t ON t.oid = ix.indrelid
         JOIN pg_namespace n ON n.oid = t.relnamespace
        WHERE n.nspname = COALESCE($1::text, current_schema()) AND t.relname = $2
        ORDER BY i.relname`,
      [sch, table],
    );

    const fks = await this.rows<{ name: string; definition: string }>(
      `SELECT con.conname AS name, pg_get_constraintdef(con.oid) AS definition
         FROM pg_constraint con
         JOIN pg_class c ON c.oid = con.conrelid
         JOIN pg_namespace n ON n.oid = c.relnamespace
        WHERE con.contype = 'f' AND n.nspname = COALESCE($1::text, current_schema()) AND c.relname = $2
        ORDER BY con.conname`,
      [sch, table],
    );

    const pkColumns = new Set(indexes.filter((i) => i.primary).flatMap((i) => i.columns));
    return {
      schema: schema ?? null,
      table,
      columns: columns.map((c) => ({
        name: c.name,
        type: c.type,
        nullable: c.nullable,
        default: c.default,
        primaryKey: pkColumns.has(c.name),
        comment: c.comment,
      })),
      indexes,
      foreignKeys: fks.map((f) => `${f.name}: ${f.definition}`),
    };
  }

  async query(sql: string, params: Param[], limits: Limits): Promise<QueryResult> {
    const started = performance.now();
    const client = await this.pool.connect();
    let broken = false;
    try {
      await client.query("BEGIN READ ONLY");
      await client.query(`SET LOCAL statement_timeout = ${int(limits.timeoutMs)}`);
      const cursor = client.query(new Cursor(sql, params, { rowMode: "array" }));
      try {
        const batch = (await cursor.read(limits.maxRows + 1)) as unknown[][];
        const truncated = batch.length > limits.maxRows;
        const rows = (truncated ? batch.slice(0, limits.maxRows) : batch).map(toJsonRow);
        const fields = (cursor as unknown as CursorWithResult)._result?.fields ?? [];
        return {
          columns: fields.map((f) => f.name),
          rows,
          truncated,
          durationMs: Math.round(performance.now() - started),
        };
      } finally {
        await cursor.close().catch(() => {});
      }
    } catch (err) {
      broken = isConnectionError(err);
      throw err;
    } finally {
      if (!broken) await client.query("ROLLBACK").catch(() => {});
      client.release(broken ? true : undefined);
    }
  }

  async execute(sql: string, params: Param[], limits: Limits): Promise<ExecuteResult> {
    const started = performance.now();
    const client = await this.pool.connect();
    let broken = false;
    try {
      await client.query("BEGIN");
      await client.query(`SET LOCAL statement_timeout = ${int(limits.timeoutMs)}`);
      const res = await client.query({ text: sql, values: params, rowMode: "array" });
      await client.query("COMMIT");
      const returning =
        res.fields && res.fields.length > 0 && Array.isArray(res.rows)
          ? {
              columns: res.fields.map((f) => f.name),
              rows: (res.rows as unknown[][]).slice(0, limits.maxRows).map(toJsonRow),
              truncated: res.rows.length > limits.maxRows,
              durationMs: 0,
            }
          : undefined;
      return {
        affectedRows: res.rowCount,
        lastInsertId: null,
        returning,
        durationMs: Math.round(performance.now() - started),
      };
    } catch (err) {
      broken = isConnectionError(err);
      if (!broken) await client.query("ROLLBACK").catch(() => {});
      throw err;
    } finally {
      client.release(broken ? true : undefined);
    }
  }

  async close(): Promise<void> {
    await this.pool.end();
  }
}

function isConnectionError(err: unknown): boolean {
  const code = (err as { code?: string } | null)?.code ?? "";
  return /^(ECONN|EPIPE|ETIMEDOUT|57P0[1-3]|08)/.test(code);
}
