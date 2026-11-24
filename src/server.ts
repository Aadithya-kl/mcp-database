import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { redact } from "./serialize.js";
import { assertReadOnly, assertWritable } from "./sql-guard.js";
import type { Adapter, Limits, Param } from "./types.js";
import { NAME, VERSION } from "./version.js";

export interface ServerOptions {
  allowWrites: boolean;
  allowDdl: boolean;
  maxRows: number;
  timeoutMs: number;
  /** Strings (connection URL, password) to scrub from error messages. */
  secrets?: string[];
}

type ToolResult = { content: Array<{ type: "text"; text: string }>; isError?: boolean };

const PLACEHOLDERS = { postgres: "$1, $2, …", mysql: "?", sqlite: "?" } as const;

const paramsSchema = z
  .array(z.union([z.string(), z.number(), z.boolean(), z.null()]))
  .optional()
  .describe("Values for the statement's placeholders. Always pass user-supplied values here instead of inlining them into the SQL.");

export function createServer(adapter: Adapter, opts: ServerOptions): McpServer {
  const limits: Limits = { maxRows: opts.maxRows, timeoutMs: opts.timeoutMs };
  const placeholder = PLACEHOLDERS[adapter.dialect];

  const ok = (data: unknown): ToolResult => ({ content: [{ type: "text", text: JSON.stringify(data) }] });
  const fail = (err: unknown): ToolResult => {
    const message = err instanceof Error ? err.message : String(err);
    return { isError: true, content: [{ type: "text", text: redact(message, opts.secrets ?? []) }] };
  };
  const guarded =
    <A>(fn: (args: A) => Promise<unknown>) =>
    async (args: A): Promise<ToolResult> => {
      try {
        return ok(await fn(args));
      } catch (err) {
        return fail(err);
      }
    };

  const mode = opts.allowWrites
    ? opts.allowDdl
      ? "read-write (DDL allowed)"
      : "read-write (DDL disabled)"
    : "read-only";

  const server = new McpServer(
    { name: NAME, version: VERSION },
    {
      instructions:
        `Connected to a ${adapter.dialect} database in ${mode} mode. ` +
        `Explore with list_schemas → list_tables → describe_table, then run SELECTs with the query tool. ` +
        `Use placeholders (${placeholder}) with the params argument. Results are capped at ${opts.maxRows} rows — add LIMIT / WHERE / aggregation instead of paging through large tables.`,
    },
  );

  server.registerTool(
    "list_schemas",
    {
      title: "List schemas",
      description: "List the schemas (databases for MySQL, attached databases for SQLite) available on this connection.",
      annotations: { readOnlyHint: true, idempotentHint: true, openWorldHint: false },
    },
    guarded(async () => ({ schemas: await adapter.listSchemas() })),
  );

  server.registerTool(
    "list_tables",
    {
      title: "List tables",
      description:
        "List tables and views in a schema with their type and (where the engine provides it) an estimated row count. " +
        "Defaults to the current schema / database.",
      inputSchema: { schema: z.string().optional().describe("Schema name. Omit for the default.") },
      annotations: { readOnlyHint: true, idempotentHint: true, openWorldHint: false },
    },
    guarded(async ({ schema }: { schema?: string }) => ({ tables: await adapter.listTables(schema) })),
  );

  server.registerTool(
    "describe_table",
    {
      title: "Describe table",
      description: "Show a table's columns (type, nullability, default, primary key), indexes and foreign keys.",
      inputSchema: {
        table: z.string().min(1).describe("Table or view name (not quoted)."),
        schema: z.string().optional().describe("Schema name. Omit for the default."),
      },
      annotations: { readOnlyHint: true, idempotentHint: true, openWorldHint: false },
    },
    guarded(async ({ table, schema }: { table: string; schema?: string }) => adapter.describeTable(table, schema)),
  );

  server.registerTool(
    "sample_rows",
    {
      title: "Sample rows",
      description: "Preview the first rows of a table or view. Quick way to see what the data looks like.",
      inputSchema: {
        table: z.string().min(1).describe("Table or view name (not quoted)."),
        schema: z.string().optional().describe("Schema name. Omit for the default."),
        limit: z.number().int().min(1).max(100).default(10).describe("Number of rows (1–100)."),
      },
      annotations: { readOnlyHint: true, idempotentHint: true, openWorldHint: false },
    },
    guarded(async ({ table, schema, limit }: { table: string; schema?: string; limit?: number }) => {
      const target = schema ? `${adapter.quoteIdent(schema)}.${adapter.quoteIdent(table)}` : adapter.quoteIdent(table);
      const n = Math.min(Math.max(1, Math.trunc(limit ?? 10)), 100);
      return withCounts(await adapter.query(`SELECT * FROM ${target} LIMIT ${n}`, [], { ...limits, maxRows: n }));
    }),
  );

  server.registerTool(
    "query",
    {
      title: "Run read-only query",
      description:
        `Run ONE read-only SQL statement (SELECT / WITH / VALUES / SHOW / EXPLAIN) against the ${adapter.dialect} database. ` +
        `Placeholders: ${placeholder}. At most ${opts.maxRows} rows are returned (truncated=true when there were more). ` +
        "Writes and multiple statements are rejected.",
      inputSchema: {
        sql: z.string().min(1).describe("A single read-only SQL statement."),
        params: paramsSchema,
      },
      annotations: { readOnlyHint: true, idempotentHint: true, openWorldHint: false },
    },
    guarded(async ({ sql, params }: { sql: string; params?: Param[] }) => {
      assertReadOnly(sql, adapter.dialect);
      return withCounts(await adapter.query(sql, params ?? [], limits));
    }),
  );

  if (opts.allowWrites) {
    server.registerTool(
      "execute",
      {
        title: "Run write statement",
        description:
          `Run ONE data-modifying statement (INSERT / UPDATE / DELETE${opts.allowDdl ? " / DDL" : ""}) inside a transaction that is committed on success. ` +
          `Placeholders: ${placeholder}. UPDATE and DELETE must have a WHERE clause. ` +
          "Confirm with the user before running anything destructive.",
        inputSchema: {
          sql: z.string().min(1).describe("A single write statement."),
          params: paramsSchema,
        },
        annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: false },
      },
      guarded(async ({ sql, params }: { sql: string; params?: Param[] }) => {
        assertWritable(sql, adapter.dialect, { allowDdl: opts.allowDdl });
        const result = await adapter.execute(sql, params ?? [], limits);
        return result.returning ? { ...result, returning: withCounts(result.returning) } : result;
      }),
    );
  }

  return server;
}

function withCounts<T extends { rows: unknown[][] }>(result: T): T & { rowCount: number } {
  return { ...result, rowCount: result.rows.length };
}
