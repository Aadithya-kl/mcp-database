import { createServer as createNetServer } from "node:net";
import { PGlite } from "@electric-sql/pglite";
import { PGLiteSocketServer } from "@electric-sql/pglite-socket";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { PostgresAdapter } from "../src/adapters/postgres.js";
import { connect as baseConnect } from "./helpers.js";

// Real PostgreSQL (PGlite, WASM) behind a TCP socket, exercised through the real `pg` driver.
let db: PGlite;
let socket: PGLiteSocketServer;
let url: string;

async function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const s = createNetServer();
    s.listen(0, "127.0.0.1", () => {
      const port = (s.address() as { port: number }).port;
      s.close(() => resolve(port));
    });
    s.on("error", reject);
  });
}

beforeAll(async () => {
  db = await PGlite.create();
  await db.exec(`
    CREATE TABLE users (id serial PRIMARY KEY, email text NOT NULL UNIQUE, name text, meta jsonb, created timestamptz DEFAULT now());
    COMMENT ON COLUMN users.email IS 'Login address';
    CREATE TABLE posts (id serial PRIMARY KEY, user_id int NOT NULL REFERENCES users(id) ON DELETE CASCADE, title text NOT NULL, big bigint);
    CREATE INDEX posts_user ON posts (user_id);
    CREATE SCHEMA analytics;
    CREATE TABLE analytics.events (id int, kind text);
    INSERT INTO users (email, name, meta) SELECT 'u' || g || '@example.com', 'User ' || g, '{"n": 1}' FROM generate_series(1, 300) g;
    INSERT INTO posts (user_id, title, big) VALUES (1, 'Hello', 9223372036854775807);
    CREATE VIEW user_emails AS SELECT email FROM users;
  `);
  const port = await freePort();
  socket = new PGLiteSocketServer({ db, port, host: "127.0.0.1" });
  await socket.start();
  url = `postgres://postgres:s3cret-pw@127.0.0.1:${port}/postgres`;
});

afterAll(async () => {
  await socket?.stop();
  await db?.close();
});

// PGlite's socket server serves one connection at a time and races when clients reconnect quickly,
// so all tests share one adapter (one pooled connection). A real PostgreSQL has no such limit.
let shared: PostgresAdapter;
const make = (): PostgresAdapter => shared;
const cleanups: Array<() => Promise<unknown>> = [];
const connect: typeof baseConnect = async (...args) => {
  const h = await baseConnect(...args);
  cleanups.push(() => h.close());
  return h;
};
beforeAll(() => {
  shared = new PostgresAdapter({ url, poolSize: 1 });
});
afterAll(async () => {
  await shared.close();
});
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup().catch(() => {});
});

describe("postgres", () => {
  it("lists schemas and tables", async () => {
    const adapter = make();
    const h = await connect(adapter);
    expect((await h.call("list_schemas")).data.schemas).toEqual(["analytics", "public"]);
    const tables = (await h.call("list_tables")).data.tables as Array<{ name: string; type: string }>;
    expect(tables.map((t) => `${t.name}:${t.type}`)).toEqual(["posts:table", "user_emails:view", "users:table"]);
    const analytics = (await h.call("list_tables", { schema: "analytics" })).data.tables;
    expect(analytics.map((t: any) => t.name)).toEqual(["events"]);
  });

  it("describes columns, comments, indexes and foreign keys", async () => {
    const adapter = make();
    const h = await connect(adapter);
    const users = (await h.call("describe_table", { table: "users" })).data;
    expect(users.columns.map((c: any) => c.name)).toEqual(["id", "email", "name", "meta", "created"]);
    expect(users.columns[0]).toMatchObject({ type: "integer", primaryKey: true, nullable: false });
    expect(users.columns[0].default).toMatch(/nextval/);
    expect(users.columns.find((c: any) => c.name === "email")).toMatchObject({ comment: "Login address", nullable: false });
    expect(users.indexes.map((i: any) => i.name).sort()).toEqual(["users_email_key", "users_pkey"]);

    const posts = (await h.call("describe_table", { table: "posts" })).data;
    expect(posts.foreignKeys[0]).toMatch(/FOREIGN KEY \(user_id\) REFERENCES users\(id\) ON DELETE CASCADE/);
    expect(posts.indexes.find((i: any) => i.name === "posts_user").columns).toEqual(["user_id"]);

    const missing = await h.call("describe_table", { table: "nope" });
    expect(missing.isError).toBe(true);
    expect(missing.text).toMatch(/not found/);
  });

  it("runs parameterised queries and serialises types", async () => {
    const adapter = make();
    const h = await connect(adapter);
    const { data } = await h.call("query", {
      sql: "SELECT u.id, u.email, u.meta, u.created, p.big FROM users u LEFT JOIN posts p ON p.user_id = u.id WHERE u.id = $1",
      params: [1],
    });
    expect(data.columns).toEqual(["id", "email", "meta", "created", "big"]);
    expect(data.rows[0][0]).toBe(1);
    expect(data.rows[0][2]).toEqual({ n: 1 });
    expect(data.rows[0][3]).toMatch(/^\d{4}-\d{2}-\d{2}T/);
    expect(data.rows[0][4]).toBe("9223372036854775807");
  });

  it("keeps duplicate column names", async () => {
    const adapter = make();
    const h = await connect(adapter);
    const { data } = await h.call("query", { sql: "SELECT u.id, p.id FROM users u JOIN posts p ON p.user_id = u.id" });
    expect(data.columns).toEqual(["id", "id"]);
    expect(data.rows).toEqual([[1, 1]]);
  });

  it("caps rows with a cursor and reports truncation", async () => {
    const adapter = make();
    const h = await connect(adapter, { maxRows: 50 });
    const { data } = await h.call("query", { sql: "SELECT * FROM users ORDER BY id" });
    expect(data.rowCount).toBe(50);
    expect(data.truncated).toBe(true);
    expect(data.rows[49][0]).toBe(50);
  });

  it("samples rows from a named schema", async () => {
    const adapter = make();
    const h = await connect(adapter);
    const { data } = await h.call("sample_rows", { table: "users", schema: "public", limit: 5 });
    expect(data.rowCount).toBe(5);
  });

  it("is read-only at the database level even when the guard is bypassed", async () => {
    const adapter = make();
    const limits = { maxRows: 10, timeoutMs: 5000 };
    await expect(adapter.query("DELETE FROM users", [], limits)).rejects.toThrow(/read-only transaction/i);
    await expect(adapter.query("INSERT INTO users (email) VALUES ('x')", [], limits)).rejects.toThrow(/read-only transaction/i);
    await expect(adapter.query("CREATE TABLE evil (a int)", [], limits)).rejects.toThrow(/read-only transaction/i);
    // The connection is reusable after an error.
    expect((await adapter.query("SELECT count(*) FROM users", [], limits)).rows[0]![0]).toBe("300");
  });

  it("rejects writes at the tool level", async () => {
    const adapter = make();
    const h = await connect(adapter);
    for (const sql of ["DELETE FROM users WHERE id = 1", "SELECT 1; DROP TABLE users", "COPY users TO PROGRAM 'id'"]) {
      expect((await h.call("query", { sql })).isError, sql).toBe(true);
    }
    expect(await h.toolNames()).not.toContain("execute");
  });

  it("surfaces SQL errors without leaking credentials", async () => {
    const adapter = make();
    const h = await connect(adapter, { secrets: [url, "s3cret-pw"] });
    const res = await h.call("query", { sql: "SELECT * FROM does_not_exist" });
    expect(res.isError).toBe(true);
    expect(res.text).toMatch(/does_not_exist/);
    expect(res.text).not.toMatch(/s3cret-pw/);
  });

  it("commits writes in read-write mode and rolls back failures", async () => {
    const adapter = make();
    const h = await connect(adapter, { allowWrites: true, allowDdl: true });
    expect(await h.toolNames()).toContain("execute");

    const ins = await h.call("execute", {
      sql: "INSERT INTO users (email, name) VALUES ($1, $2) RETURNING id, email",
      params: ["rw@example.com", "RW"],
    });
    expect(ins.isError).toBe(false);
    expect(ins.data.affectedRows).toBe(1);
    expect(ins.data.returning.rows[0][1]).toBe("rw@example.com");

    const dup = await h.call("execute", { sql: "INSERT INTO users (email) VALUES ($1)", params: ["rw@example.com"] });
    expect(dup.isError).toBe(true);
    expect(dup.text).toMatch(/duplicate key|unique/i);

    const del = await h.call("execute", { sql: "DELETE FROM users WHERE email = $1", params: ["rw@example.com"] });
    expect(del.data.affectedRows).toBe(1);
    expect((await h.call("query", { sql: "SELECT count(*) FROM users" })).data.rows[0][0]).toBe("300");

    expect((await h.call("execute", { sql: "DELETE FROM users" })).isError).toBe(true);
  });

  it("applies the configured statement timeout to every query", async () => {
    // PGlite is single-threaded WASM and cannot interrupt a running statement, so we verify that the
    // limit is set on the session; enforcement itself is PostgreSQL's job.
    const adapter = make();
    const res = await adapter.query("SHOW statement_timeout", [], { maxRows: 10, timeoutMs: 300 });
    expect(res.rows[0]![0]).toBe("300ms");
    // SET LOCAL must not leak to the next query.
    const again = await adapter.query("SHOW statement_timeout", [], { maxRows: 10, timeoutMs: 7000 });
    expect(again.rows[0]![0]).toBe("7s");
  });
});
