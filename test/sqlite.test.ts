import { mkdtempSync, rmSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { SqliteAdapter } from "../src/adapters/sqlite.js";
import { connect, type Harness } from "./helpers.js";

let dir: string;
let file: string;

beforeAll(() => {
  dir = mkdtempSync(join(tmpdir(), "mcp-database-"));
  file = join(dir, "app.db");
  const db = new DatabaseSync(file);
  db.exec(`
    CREATE TABLE users (id INTEGER PRIMARY KEY, email TEXT NOT NULL UNIQUE, name TEXT, created TEXT DEFAULT 'now');
    CREATE TABLE posts (
      id INTEGER PRIMARY KEY, user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      title TEXT NOT NULL, body BLOB, big INTEGER
    );
    CREATE INDEX posts_user ON posts(user_id);
    CREATE VIEW user_emails AS SELECT email FROM users;
  `);
  const insert = db.prepare("INSERT INTO users (email, name) VALUES (?, ?)");
  for (let i = 1; i <= 500; i++) insert.run(`u${i}@example.com`, `User ${i}`);
  db.prepare("INSERT INTO posts (user_id, title, body, big) VALUES (1, 'Hello', ?, 9223372036854775807)").run(new Uint8Array([1, 2, 3]));
  db.close();
});

afterAll(() => rmSync(dir, { recursive: true, force: true }));

async function open(opts: { writable?: boolean; allowDdl?: boolean; maxRows?: number } = {}): Promise<Harness> {
  const adapter = await SqliteAdapter.open({ path: file, writable: opts.writable ?? false });
  return connect(adapter, { allowWrites: opts.writable ?? false, allowDdl: opts.allowDdl ?? false, maxRows: opts.maxRows ?? 200 });
}

describe("sqlite: read-only mode", () => {
  it("exposes only read tools", async () => {
    const h = await open();
    expect(await h.toolNames()).toEqual(["describe_table", "list_schemas", "list_tables", "query", "sample_rows"]);
    await h.close();
  });

  it("lists schemas and tables", async () => {
    const h = await open();
    expect((await h.call("list_schemas")).data.schemas).toEqual(["main"]);
    const tables = (await h.call("list_tables")).data.tables as Array<{ name: string; type: string }>;
    expect(tables).toEqual([
      { name: "posts", type: "table", estimatedRows: null },
      { name: "user_emails", type: "view", estimatedRows: null },
      { name: "users", type: "table", estimatedRows: null },
    ]);
    await h.close();
  });

  it("describes columns, indexes and foreign keys", async () => {
    const h = await open();
    const { data } = await h.call("describe_table", { table: "posts" });
    expect(data.columns.map((c: any) => c.name)).toEqual(["id", "user_id", "title", "body", "big"]);
    expect(data.columns.find((c: any) => c.name === "id").primaryKey).toBe(true);
    expect(data.columns.find((c: any) => c.name === "title").nullable).toBe(false);
    expect(data.indexes.some((i: any) => i.name === "posts_user" && i.columns[0] === "user_id")).toBe(true);
    expect(data.foreignKeys).toEqual(["FOREIGN KEY (user_id) REFERENCES users (id) ON DELETE CASCADE"]);
    await h.close();
  });

  it("reports unknown tables as an error", async () => {
    const h = await open();
    const res = await h.call("describe_table", { table: "nope" });
    expect(res.isError).toBe(true);
    expect(res.text).toMatch(/not found/);
    await h.close();
  });

  it("runs parameterised queries", async () => {
    const h = await open();
    const { data } = await h.call("query", { sql: "SELECT id, email FROM users WHERE id = ?", params: [7] });
    expect(data.columns).toEqual(["id", "email"]);
    expect(data.rows).toEqual([[7, "u7@example.com"]]);
    expect(data.truncated).toBe(false);
    await h.close();
  });

  it("caps rows and reports truncation", async () => {
    const h = await open({ maxRows: 25 });
    const { data } = await h.call("query", { sql: "SELECT * FROM users" });
    expect(data.rowCount).toBe(25);
    expect(data.truncated).toBe(true);
    await h.close();
  });

  it("keeps duplicate column names", async () => {
    const h = await open();
    const { data } = await h.call("query", {
      sql: "SELECT u.id, p.id FROM users u JOIN posts p ON p.user_id = u.id",
    });
    expect(data.columns).toEqual(["id", "id"]);
    expect(data.rows).toEqual([[1, 1]]);
    await h.close();
  });

  it("serialises bigint and binary values safely", async () => {
    const h = await open();
    const { data } = await h.call("query", { sql: "SELECT big, body FROM posts" });
    expect(data.rows[0][0]).toBe("9223372036854775807");
    expect(data.rows[0][1]).toMatch(/^<binary 3 bytes: 0x010203>$/);
    await h.close();
  });

  it("samples rows", async () => {
    const h = await open();
    const { data } = await h.call("sample_rows", { table: "users", limit: 3 });
    expect(data.rowCount).toBe(3);
    await h.close();
  });

  it("rejects writes, multi-statements and dangerous pragmas before they reach the database", async () => {
    const h = await open();
    for (const sql of [
      "DELETE FROM users WHERE id = 1",
      "INSERT INTO users (email) VALUES ('x')",
      "SELECT 1; DROP TABLE users",
      "PRAGMA query_only = OFF",
      "ATTACH DATABASE '/tmp/evil.db' AS evil",
    ]) {
      const res = await h.call("query", { sql });
      expect(res.isError, sql).toBe(true);
    }
    expect((await h.call("query", { sql: "SELECT count(*) FROM users" })).data.rows[0][0]).toBe(500);
    await h.close();
  });

  it("is read-only at the database level too (guard bypassed)", async () => {
    const adapter = await SqliteAdapter.open({ path: file, writable: false });
    await expect(adapter.query("DELETE FROM users", [], { maxRows: 10, timeoutMs: 1000 })).rejects.toThrow(/readonly|read-only|read only/i);
    await expect(adapter.query("PRAGMA query_only = OFF", [], { maxRows: 10, timeoutMs: 1000 }).then(() =>
      adapter.query("DELETE FROM users", [], { maxRows: 10, timeoutMs: 1000 }),
    )).rejects.toThrow(/readonly|read-only|read only/i);
    await adapter.close();
  });
});

describe("sqlite: read-write mode", () => {
  it("adds the execute tool and commits writes", async () => {
    const h = await open({ writable: true });
    expect(await h.toolNames()).toContain("execute");

    const ins = await h.call("execute", { sql: "INSERT INTO users (email, name) VALUES (?, ?)", params: ["new@example.com", "New"] });
    expect(ins.isError).toBe(false);
    expect(ins.data.affectedRows).toBe(1);

    const upd = await h.call("execute", { sql: "UPDATE users SET name = ? WHERE email = ?", params: ["Renamed", "new@example.com"] });
    expect(upd.data.affectedRows).toBe(1);

    const q = await h.call("query", { sql: "SELECT name FROM users WHERE email = ?", params: ["new@example.com"] });
    expect(q.data.rows).toEqual([["Renamed"]]);

    const del = await h.call("execute", { sql: "DELETE FROM users WHERE email = ?", params: ["new@example.com"] });
    expect(del.data.affectedRows).toBe(1);
    await h.close();
  });

  it("still refuses unscoped UPDATE/DELETE, DDL and reads in execute", async () => {
    const h = await open({ writable: true });
    for (const sql of ["DELETE FROM users", "UPDATE users SET name = 'x'", "DROP TABLE users", "SELECT 1"]) {
      expect((await h.call("execute", { sql })).isError, sql).toBe(true);
    }
    await h.close();
  });

  it("allows DDL only with allowDdl", async () => {
    const h = await open({ writable: true, allowDdl: true });
    const res = await h.call("execute", { sql: "CREATE TABLE scratch (a INTEGER)" });
    expect(res.isError).toBe(false);
    await h.call("execute", { sql: "DROP TABLE scratch" });
    await h.close();
  });
});

describe("sqlite: in-memory", () => {
  it("works with :memory:", async () => {
    const adapter = await SqliteAdapter.open({ path: ":memory:", writable: true });
    const h = await connect(adapter, { allowWrites: true, allowDdl: true });
    await h.call("execute", { sql: "CREATE TABLE t (a INTEGER)" });
    await h.call("execute", { sql: "INSERT INTO t VALUES (1), (2)" });
    expect((await h.call("query", { sql: "SELECT sum(a) FROM t" })).data.rows).toEqual([[3]]);
    await h.close();
  });
});
