import { spawn, type ChildProcess } from "node:child_process";

/**
 * Runs read-only SQLite queries in a child process so they can be stopped.
 *
 * `node:sqlite` executes a statement synchronously inside one native call and
 * exposes no `sqlite3_interrupt`. A query such as an unbounded recursive CTE
 * therefore blocks whatever thread runs it, and terminating a worker thread
 * does not help: V8 can only stop JavaScript, so the native call keeps running.
 * A child process can be killed with SIGKILL, which really ends the query.
 *
 * The child opens its own connection with `readOnly: true` and
 * `PRAGMA query_only = ON`, so it cannot write even if the guard were bypassed.
 * It is started on the first query, reused for later ones, and restarted after
 * a timeout. Queries run one at a time, in order.
 */

// CommonJS, evaluated with `node -e`. Kept as plain JavaScript so it needs no build step.
const CHILD_SOURCE = String.raw`
const { DatabaseSync } = require("node:sqlite");
let db = null;
process.on("message", (msg) => {
  try {
    if (msg.type === "open") {
      db = new DatabaseSync(msg.path, { readOnly: true });
      db.exec("PRAGMA query_only = ON");
      process.send({ id: msg.id, ok: true });
      return;
    }
    const stmt = db.prepare(msg.sql);
    stmt.setReadBigInts(true);
    stmt.setReturnArrays(true);
    const columns = stmt.columns().map((c) => c.name);
    const rows = [];
    let truncated = false;
    for (const row of stmt.iterate(...msg.params)) {
      if (rows.length >= msg.maxRows) { truncated = true; break; }
      rows.push(row);
    }
    process.send({ id: msg.id, ok: true, columns, rows, truncated });
  } catch (err) {
    process.send({ id: msg.id, ok: false, message: err instanceof Error ? err.message : String(err) });
  }
});
process.on("disconnect", () => process.exit(0));
`;

export interface RunnerResult {
  columns: string[];
  rows: unknown[][];
  truncated: boolean;
}

interface Reply {
  id: number;
  ok: boolean;
  message?: string;
  columns?: string[];
  rows?: unknown[][];
  truncated?: boolean;
}

export class SqliteTimeoutError extends Error {
  constructor(timeoutMs: number) {
    super(
      `Query stopped after the ${timeoutMs} ms timeout. ` +
        "Add a LIMIT, narrow the WHERE clause, or check recursive CTEs for a missing stop condition.",
    );
    this.name = "SqliteTimeoutError";
  }
}

export class SqliteQueryRunner {
  private child: ChildProcess | null = null;
  private nextId = 1;
  private pending = new Map<number, { resolve: (r: Reply) => void; reject: (e: Error) => void }>();
  /** Serialises queries: the child handles one statement at a time. */
  private queue: Promise<unknown> = Promise.resolve();
  private closed = false;

  constructor(private readonly path: string) {}

  /** Process id of the current query process, if one is running. Used by tests. */
  get pid(): number | undefined {
    return this.child?.pid;
  }

  run(sql: string, params: unknown[], maxRows: number, timeoutMs: number): Promise<RunnerResult> {
    const task = this.queue.then(() => this.runNow(sql, params, maxRows, timeoutMs));
    this.queue = task.catch(() => undefined);
    return task;
  }

  async close(): Promise<void> {
    this.closed = true;
    this.kill(new Error("Database connection closed."));
  }

  private async runNow(sql: string, params: unknown[], maxRows: number, timeoutMs: number): Promise<RunnerResult> {
    if (this.closed) throw new Error("Database connection closed.");
    if (!this.child) await this.start();
    const reply = await this.request({ type: "query", sql, params, maxRows }, timeoutMs);
    return { columns: reply.columns ?? [], rows: reply.rows ?? [], truncated: reply.truncated ?? false };
  }

  private async start(): Promise<void> {
    const child = spawn(process.execPath, ["--disable-warning=ExperimentalWarning", "-e", CHILD_SOURCE], {
      // stdout belongs to the MCP protocol in the parent, so the child must never write to it.
      stdio: ["ignore", "ignore", "inherit", "ipc"],
      // Structured clone keeps BigInt and Uint8Array values intact.
      serialization: "advanced",
    });
    this.child = child;
    // Never keep the server alive just because a query process exists; pending
    // request timers keep the event loop running while a query is in flight.
    child.unref();
    child.channel?.unref();
    // A child stuck in a native call cannot notice that its parent went away,
    // so kill it on any exit path, including process.exit() after a crash handler.
    const killOnExit = () => {
      if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL");
    };
    process.once("exit", killOnExit);
    child.once("exit", () => process.removeListener("exit", killOnExit));
    child.on("message", (reply: Reply) => {
      const waiter = this.pending.get(reply.id);
      if (!waiter) return;
      this.pending.delete(reply.id);
      waiter.resolve(reply);
    });
    // Only the current process may fail pending requests: a process that was
    // already replaced (after a timeout) can report its exit after the new one started.
    child.on("exit", () => {
      if (this.child !== child) return;
      this.child = null;
      this.failPending(new Error("SQLite query process exited unexpectedly."));
    });
    child.on("error", (err) => {
      if (this.child !== child) return;
      this.child = null;
      this.failPending(err);
    });
    // Opening a local file is fast; the generous limit only guards against a stuck spawn.
    try {
      await this.request({ type: "open", path: this.path }, 10_000);
    } catch (err) {
      // Do not keep a process with no open database: the next query starts a new one.
      this.kill(null);
      throw err;
    }
  }

  private request(message: Record<string, unknown>, timeoutMs: number): Promise<Reply> {
    const child = this.child;
    if (!child) return Promise.reject(new Error("SQLite query process is not running."));
    const id = this.nextId++;
    return new Promise<Reply>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        this.kill(null);
        reject(new SqliteTimeoutError(timeoutMs));
      }, timeoutMs);
      this.pending.set(id, {
        resolve: (reply) => {
          clearTimeout(timer);
          if (reply.ok) resolve(reply);
          else reject(new Error(reply.message ?? "SQLite query failed."));
        },
        reject: (err) => {
          clearTimeout(timer);
          reject(err);
        },
      });
      child.send({ ...message, id });
    });
  }

  private kill(reason: Error | null): void {
    const child = this.child;
    this.child = null;
    if (reason) this.failPending(reason);
    if (child && child.exitCode === null && child.signalCode === null) child.kill("SIGKILL");
  }

  private failPending(err: Error): void {
    const waiters = [...this.pending.values()];
    this.pending.clear();
    for (const w of waiters) w.reject(err);
  }
}
