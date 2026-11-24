/**
 * Statement guard.
 *
 * This is a *defence-in-depth* layer. The primary safety boundary is always the
 * database itself (read-only transaction / read-only connection / a role with
 * minimal grants). The guard exists to give the model fast, readable feedback and
 * to stop obviously dangerous statements before they reach the driver.
 */

export type Dialect = "postgres" | "mysql" | "sqlite";
export type StatementKind = "read" | "write" | "ddl" | "blocked";

export interface Analysis {
  kind: StatementKind;
  /** First keyword of the statement, lower-cased (empty when blocked early). */
  keyword: string;
  /** Human-readable reason when `kind === "blocked"`. */
  reason?: string;
  /** True when an UPDATE/DELETE has a WHERE clause. */
  hasWhere: boolean;
}

export class GuardError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "GuardError";
  }
}

const IDENT_PLACEHOLDER = "_ident_";
const STRING_PLACEHOLDER = "''";

/**
 * Replace comments, string literals and quoted identifiers with neutral
 * placeholders so that keyword scanning cannot be fooled by their contents.
 * The rules differ per dialect (MySQL `--` needs trailing whitespace, `#`
 * comments, backslash escapes, SQLite `[bracket]` identifiers, PostgreSQL
 * dollar-quoting and nested block comments, ...).
 */
export function sanitize(sql: string, dialect: Dialect): string {
  let out = "";
  let i = 0;
  const n = sql.length;

  while (i < n) {
    const ch = sql[i]!;
    const next = sql[i + 1];

    // -- line comment
    if (ch === "-" && next === "-") {
      const after = sql[i + 2];
      const isComment =
        dialect !== "mysql" || after === undefined || /[\s\x00-\x1f]/.test(after);
      if (isComment) {
        i += 2;
        while (i < n && sql[i] !== "\n") i++;
        out += " ";
        continue;
      }
    }

    // # line comment (MySQL only)
    if (ch === "#" && dialect === "mysql") {
      while (i < n && sql[i] !== "\n") i++;
      out += " ";
      continue;
    }

    // /* block comment */ (nested in PostgreSQL)
    if (ch === "/" && next === "*") {
      let depth = 1;
      i += 2;
      while (i < n && depth > 0) {
        if (sql[i] === "/" && sql[i + 1] === "*" && dialect === "postgres") {
          depth++;
          i += 2;
        } else if (sql[i] === "*" && sql[i + 1] === "/") {
          depth--;
          i += 2;
        } else {
          i++;
        }
      }
      out += " ";
      continue;
    }

    // PostgreSQL dollar-quoted strings: $$ ... $$ or $tag$ ... $tag$
    if (ch === "$" && dialect === "postgres") {
      const m = /^\$([A-Za-z_][A-Za-z0-9_]*)?\$/.exec(sql.slice(i));
      if (m) {
        const delim = m[0];
        const end = sql.indexOf(delim, i + delim.length);
        i = end === -1 ? n : end + delim.length;
        out += STRING_PLACEHOLDER;
        continue;
      }
    }

    // 'string' (and "string" in MySQL)
    if (ch === "'" || (ch === '"' && dialect === "mysql")) {
      const quote = ch;
      const backslashEscapes =
        dialect === "mysql" ||
        (dialect === "postgres" && /[eE]$/.test(out) && !/[A-Za-z0-9_]$/.test(out.slice(0, -1)));
      i++;
      while (i < n) {
        const c = sql[i]!;
        if (backslashEscapes && c === "\\") {
          i += 2;
          continue;
        }
        if (c === quote) {
          if (sql[i + 1] === quote) {
            i += 2;
            continue;
          }
          i++;
          break;
        }
        i++;
      }
      out += STRING_PLACEHOLDER;
      continue;
    }

    // "identifier" (PostgreSQL / SQLite), `identifier` (MySQL / SQLite), [identifier] (SQLite)
    if (ch === '"' || ch === "`" || (ch === "[" && dialect === "sqlite")) {
      const close = ch === "[" ? "]" : ch;
      i++;
      while (i < n) {
        if (sql[i] === close) {
          if (close !== "]" && sql[i + 1] === close) {
            i += 2;
            continue;
          }
          i++;
          break;
        }
        i++;
      }
      out += IDENT_PLACEHOLDER;
      continue;
    }

    out += ch;
    i++;
  }

  return out;
}

const READ_KEYWORDS = new Set(["select", "with", "values", "table", "show", "describe", "desc", "explain", "pragma"]);
const WRITE_KEYWORDS = new Set(["insert", "update", "delete", "replace", "merge", "upsert"]);
const DDL_KEYWORDS = new Set([
  "create",
  "alter",
  "drop",
  "truncate",
  "rename",
  "comment",
  "grant",
  "revoke",
  "reindex",
  "vacuum",
  "analyze",
  "optimize",
  "cluster",
  "refresh",
]);

/** Read-only PRAGMAs that are safe to expose (no assignment form). */
const SAFE_PRAGMAS = new Set([
  "table_info",
  "table_xinfo",
  "table_list",
  "index_list",
  "index_info",
  "index_xinfo",
  "foreign_key_list",
  "foreign_key_check",
  "database_list",
  "collation_list",
  "compile_options",
  "function_list",
  "module_list",
  "user_version",
  "schema_version",
  "freelist_count",
  "page_count",
  "page_size",
  "encoding",
]);

/** Matches DML hidden inside WITH / EXPLAIN (data-modifying CTEs, EXPLAIN ANALYZE DELETE ...). */
const EMBEDDED_WRITE = /\b(insert\s+into|delete\s+from|merge\s+into|replace\s+into)\b|\bupdate\b[\s\S]*?\bset\b/;

/** Constructs that are never allowed, in any mode. */
const DENYLIST: Array<[RegExp, string]> = [
  [/\binto\s+(outfile|dumpfile)\b/, "SELECT ... INTO OUTFILE/DUMPFILE writes files on the database server"],
  [/\bload_file\s*\(/, "LOAD_FILE() reads files from the database server"],
  [/\bload\s+data\b/, "LOAD DATA is not allowed"],
  [/\b(pg_read_file|pg_read_binary_file|pg_ls_dir|pg_stat_file|lo_import|lo_export)\s*\(/, "server-side file access functions are not allowed"],
  [/\b(pg_terminate_backend|pg_cancel_backend|pg_reload_conf|pg_rotate_logfile)\s*\(/, "backend control functions are not allowed"],
  [/\bdblink(_exec|_connect)?\s*\(/, "dblink is not allowed"],
  [/\bload_extension\s*\(/, "load_extension() is not allowed"],
  [/\b(readfile|writefile)\s*\(/, "file I/O functions are not allowed"],
  [/\b(sys_exec|sys_eval)\s*\(/, "command execution functions are not allowed"],
];

export function analyze(sql: string, dialect: Dialect): Analysis {
  const blocked = (reason: string, keyword = ""): Analysis => ({ kind: "blocked", keyword, reason, hasWhere: false });

  if (sql.trim() === "") return blocked("Empty statement.");
  if (dialect === "mysql" && sql.includes("/*!")) {
    return blocked("MySQL executable comments (/*! ... */) are not allowed.");
  }

  const clean = sanitize(sql, dialect).toLowerCase();
  const statements = clean
    .split(";")
    .map((s) => s.trim())
    .filter((s) => s.length > 0);

  if (statements.length === 0) return blocked("Empty statement.");
  if (statements.length > 1) {
    return blocked("Multiple statements are not allowed. Send one statement per call.");
  }

  const stmt = statements[0]!;
  const keywordMatch = /^[a-z_]+/.exec(stmt);
  const keyword = keywordMatch ? keywordMatch[0] : "";
  if (!keyword) return blocked("Could not determine the statement type.");

  for (const [pattern, reason] of DENYLIST) {
    if (pattern.test(stmt)) return blocked(reason, keyword);
  }

  const hasWhere = /\bwhere\b/.test(stmt);

  if (READ_KEYWORDS.has(keyword)) {
    if (keyword === "pragma") {
      if (dialect !== "sqlite") return blocked("PRAGMA is only available on SQLite.", keyword);
      const m = /^pragma\s+(?:[a-z_]+\.)?([a-z_]+)\s*(\(|=)?/.exec(stmt);
      const name = m?.[1] ?? "";
      if (m?.[2] === "=" || !SAFE_PRAGMAS.has(name)) {
        return blocked(`PRAGMA ${name || "(unknown)"} is not allowed. Allowed: ${[...SAFE_PRAGMAS].join(", ")}.`, keyword);
      }
      return { kind: "read", keyword, hasWhere };
    }
    if ((keyword === "with" || keyword === "explain") && EMBEDDED_WRITE.test(stmt)) {
      return { kind: "write", keyword, hasWhere };
    }
    return { kind: "read", keyword, hasWhere };
  }

  if (WRITE_KEYWORDS.has(keyword)) return { kind: "write", keyword, hasWhere };
  if (DDL_KEYWORDS.has(keyword)) return { kind: "ddl", keyword, hasWhere };

  return blocked(`Statement type "${keyword.toUpperCase()}" is not allowed.`, keyword);
}

/** Throws unless `sql` is a single read-only statement. */
export function assertReadOnly(sql: string, dialect: Dialect): void {
  const a = analyze(sql, dialect);
  if (a.kind === "blocked") throw new GuardError(a.reason ?? "Statement blocked.");
  if (a.kind !== "read") {
    throw new GuardError(
      `This tool only runs read-only statements (SELECT / WITH / SHOW / EXPLAIN / VALUES). Got ${a.keyword.toUpperCase()}. ` +
        "Use the `execute` tool for writes (requires the server to be started with --read-write).",
    );
  }
}

export interface WriteOptions {
  allowDdl: boolean;
}

/** Throws unless `sql` is a single permitted write statement. */
export function assertWritable(sql: string, dialect: Dialect, opts: WriteOptions): StatementKind {
  const a = analyze(sql, dialect);
  if (a.kind === "blocked") throw new GuardError(a.reason ?? "Statement blocked.");
  if (a.kind === "read") {
    throw new GuardError("This is a read-only statement. Use the `query` tool instead.");
  }
  if (a.kind === "ddl" && !opts.allowDdl) {
    throw new GuardError(
      `${a.keyword.toUpperCase()} is a schema-changing statement. Start the server with --allow-ddl to permit DDL.`,
    );
  }
  if (a.kind === "write" && (a.keyword === "update" || a.keyword === "delete") && !a.hasWhere) {
    throw new GuardError(
      `${a.keyword.toUpperCase()} without a WHERE clause is refused. Add a WHERE clause (use WHERE 1=1 if you really mean every row).`,
    );
  }
  return a.kind;
}
