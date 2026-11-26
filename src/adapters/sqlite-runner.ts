import { spawn, type ChildProcess } from "node:child_process";
import type { SQLInputValue } from "node:sqlite";

export interface RawRows {
  columns: string[];
  rows: unknown[][];
  truncated: boolean;
}

type Reply = ({ ok: true } & Partial<RawRows>) | { ok: false; error: string };

/**
 * Source of the child process that runs read-only SQLite queries. It is plain CommonJS passed to
 * `node -e`, so it survives bundling and needs no separate entry point. It opens its own
 * connection `readOnly` with `PRAGMA query_only = ON`, whatever mode the server runs in.
 */
const CHILD_SOURCE = `"use strict";
const { DatabaseSync } = require("node:sqlite");
let db;
process.on("disconnect", () => process.exit(0));
process.on("message", (msg) => {
  try {
    if (msg.type === "open") {
      db = new DatabaseSync(msg.path, { readOnly: true });
      db.exec("PRAGMA query_only = ON");
      process.send({ ok: true });
      return;
    }
    const stmt = db.prepare(msg.sql);
    stmt.setReadBigInts(true);
    stmt.setReturnArrays(true);
    const columns = stmt.columns().map((c) => c.name);
    const rows = [];
    let truncated = false;
    for (const row of stmt.iterate(...msg.params)) {
      if (rows.length >= msg.maxRows) {
        truncated = true;
        break;
      }
      rows.push(row);
    }
    process.send({ ok: true, columns, rows, truncated });
  } catch (err) {
    process.send({ ok: false, error: err instanceof Error ? err.message : String(err) });
  }
});
`;

export class QueryTimeoutError extends Error {
  constructor(timeoutMs: number) {
    super(
      `Query cancelled: it ran longer than the ${timeoutMs} ms timeout (--timeout-ms). ` +
        "Narrow it with WHERE / LIMIT, or check recursive CTEs for a missing termination condition.",
    );
    this.name = "QueryTimeoutError";
  }
}

/**
 * Runs SQLite queries in a separate Node.js process so they can be cancelled.
 *
 * `node:sqlite` is synchronous and exposes no interrupt, so a long statement can only be stopped by
 * killing the thread that runs it. A `worker_thread` does not work for this: `Worker#terminate()`
 * cannot stop native code, so it never returns while SQLite is busy. A child process can be killed
 * at any time; the next query starts a fresh one with a new read-only connection.
 *
 * Queries are run one at a time, in the order they were submitted.
 */
export class SqliteQueryRunner {
  private child: ChildProcess | null = null;
  private starting: Promise<ChildProcess> | null = null;
  private queue: Promise<unknown> = Promise.resolve();
  private closed = false;

  constructor(private readonly path: string) {}

  query(sql: string, params: SQLInputValue[], opts: { maxRows: number; timeoutMs: number }): Promise<RawRows> {
    const task = this.queue.then(async () => {
      const child = await this.start();
      const reply = await this.request(child, { type: "query", sql, params, maxRows: opts.maxRows }, opts.timeoutMs);
      return { columns: reply.columns ?? [], rows: reply.rows ?? [], truncated: reply.truncated ?? false };
    });
    this.queue = task.catch(() => {});
    return task;
  }

  close(): void {
    this.closed = true;
    this.kill();
  }

  private start(): Promise<ChildProcess> {
    if (this.closed) return Promise.reject(new Error("Database connection is closed."));
    this.starting ??= (async () => {
      const child = spawn(process.execPath, ["--disable-warning=ExperimentalWarning", "-e", CHILD_SOURCE], {
        stdio: ["ignore", "ignore", "inherit", "ipc"],
        // Structured clone keeps bigint and Uint8Array values intact.
        serialization: "advanced",
      });
      child.unref();
      child.channel?.unref();
      child.once("exit", () => {
        if (this.child === child) {
          this.child = null;
          this.starting = null;
        }
      });
      this.child = child;
      try {
        await this.request(child, { type: "open", path: this.path });
        return child;
      } catch (err) {
        this.kill();
        throw err;
      }
    })();
    return this.starting;
  }

  private request(child: ChildProcess, message: object, timeoutMs?: number): Promise<Partial<RawRows>> {
    return new Promise((resolve, reject) => {
      let timer: NodeJS.Timeout | undefined;
      let settled = false;
      const settle = (): void => {
        settled = true;
        if (timer) clearTimeout(timer);
        child.off("message", onMessage);
        child.off("exit", onExit);
        child.off("error", onError);
        child.channel?.unref();
      };
      const onMessage = (reply: Reply): void => {
        settle();
        if (reply.ok) resolve(reply);
        else reject(new Error(reply.error));
      };
      const onExit = (code: number | null, signal: NodeJS.Signals | null): void => {
        settle();
        reject(new Error(`SQLite query process exited unexpectedly (${signal ?? `code ${code}`}).`));
      };
      const onError = (err: Error): void => {
        if (settled) return;
        settle();
        this.kill();
        reject(err);
      };
      child.on("message", onMessage);
      child.on("exit", onExit);
      child.on("error", onError);
      // Keep the event loop alive while a reply is outstanding.
      child.channel?.ref();
      if (timeoutMs !== undefined) {
        timer = setTimeout(() => {
          settle();
          this.kill();
          reject(new QueryTimeoutError(timeoutMs));
        }, timeoutMs);
      }
      child.send(message, (err) => {
        if (err) onError(err);
      });
    });
  }

  private kill(): void {
    this.child?.kill("SIGKILL");
    this.child = null;
    this.starting = null;
  }
}
