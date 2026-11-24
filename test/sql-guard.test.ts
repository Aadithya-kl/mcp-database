import { describe, expect, it } from "vitest";
import { analyze, assertReadOnly, assertWritable, sanitize, type Dialect } from "../src/sql-guard.js";

const kind = (sql: string, d: Dialect = "postgres") => analyze(sql, d).kind;

describe("sanitize", () => {
  it("strips comments and string contents", () => {
    expect(sanitize("select 'drop table x' -- delete from y\n, 1", "postgres")).not.toMatch(/drop|delete/);
    expect(sanitize("select /* drop */ 1", "postgres")).not.toMatch(/drop/);
  });

  it("handles PostgreSQL dollar quoting and nested comments", () => {
    expect(sanitize("select $$; drop table x;$$", "postgres")).not.toMatch(/drop/);
    expect(sanitize("select $tag$ delete from x $tag$", "postgres")).not.toMatch(/delete/);
    expect(sanitize("select /* a /* b */ drop */ 1", "postgres")).not.toMatch(/drop/);
  });

  it("treats `--` as a MySQL comment only when followed by whitespace", () => {
    // `1--1` is arithmetic in MySQL, so the rest of the line is still code.
    expect(sanitize("select 1--1; drop table x", "mysql")).toMatch(/drop/);
    expect(sanitize("select 1 -- note; drop table x\n", "mysql")).not.toMatch(/drop/);
  });

  it("handles MySQL # comments and backslash escapes", () => {
    expect(sanitize("select 1 # drop table x\n", "mysql")).not.toMatch(/drop/);
    expect(sanitize("select 'it\\'s; drop table x'", "mysql")).not.toMatch(/drop/);
  });

  it("does not treat quoted identifiers as keywords", () => {
    expect(sanitize('select "delete" from "drop"', "postgres")).not.toMatch(/delete|drop/);
    expect(sanitize("select [delete] from t", "sqlite")).not.toMatch(/delete/);
  });
});

describe("analyze: classification", () => {
  it.each([
    "select 1",
    "SELECT * FROM users WHERE id = $1",
    "  \n with a as (select 1) select * from a",
    "values (1), (2)",
    "show tables",
    "explain select 1",
    "select 1;",
    "select replace(name, 'a', 'b') from t",
    "select * from t for update",
    "-- hello\nselect 1",
  ])("read: %s", (sql) => {
    expect(kind(sql)).toBe("read");
  });

  it.each([
    "insert into t values (1)",
    "update t set a = 1 where id = 1",
    "delete from t where id = 1",
    "replace into t values (1)",
    "with x as (delete from t returning *) select * from x",
    "explain analyze delete from t",
    "explain analyze update t set a = 1",
  ])("write: %s", (sql) => {
    expect(kind(sql)).toBe("write");
  });

  it.each(["create table t (a int)", "drop table t", "alter table t add b int", "truncate t", "grant all on t to x"])(
    "ddl: %s",
    (sql) => {
      expect(kind(sql)).toBe("ddl");
    },
  );

  it.each([
    "",
    "   ",
    "select 1; select 2",
    "select 1; drop table t",
    "select 1;; drop table t",
    "call do_something()",
    "copy t to program 'rm -rf /'",
    "set role admin",
    "begin",
    "attach database 'x' as y",
    "select load_file('/etc/passwd')",
    "select * into outfile '/tmp/x' from t",
    "select pg_read_file('/etc/passwd')",
    "select lo_import('/etc/passwd')",
    "select pg_terminate_backend(1)",
  ])("blocked: %j", (sql) => {
    expect(kind(sql)).toBe("blocked");
  });

  it("is not fooled by keywords hidden in strings or comments", () => {
    expect(kind("select 'a; drop table t'")).toBe("read");
    expect(kind("select 1 /* ; drop table t */")).toBe("read");
    expect(kind("select 1 -- ; drop table t")).toBe("read");
    expect(kind("select $$; drop table t$$")).toBe("read");
  });

  it("is not fooled by a comment split across statements", () => {
    expect(kind("select 1 /* x */; /* y */ drop table t")).toBe("blocked");
  });

  it("blocks MySQL executable comments", () => {
    expect(kind("select 1 /*! ; drop table t */", "mysql")).toBe("blocked");
    expect(kind("select /*+ MAX_EXECUTION_TIME(10) */ 1", "mysql")).toBe("read");
  });

  it("only allows read-only SQLite pragmas", () => {
    expect(kind("pragma table_info(t)", "sqlite")).toBe("read");
    expect(kind("PRAGMA main.index_list('t')", "sqlite")).toBe("read");
    expect(kind("pragma query_only = OFF", "sqlite")).toBe("blocked");
    expect(kind("pragma journal_mode = delete", "sqlite")).toBe("blocked");
    expect(kind("pragma writable_schema = 1", "sqlite")).toBe("blocked");
    expect(kind("pragma table_info(t)", "postgres")).toBe("blocked");
  });

  it("blocks SQLite extension loading and file I/O", () => {
    expect(kind("select load_extension('x')", "sqlite")).toBe("blocked");
    expect(kind("select writefile('/tmp/x', 'y')", "sqlite")).toBe("blocked");
  });
});

describe("assertReadOnly / assertWritable", () => {
  it("rejects writes in read-only tools with a helpful message", () => {
    expect(() => assertReadOnly("delete from t", "postgres")).toThrow(/execute/);
    expect(() => assertReadOnly("select 1; select 2", "postgres")).toThrow(/Multiple statements/);
    expect(() => assertReadOnly("select 1", "postgres")).not.toThrow();
  });

  it("requires WHERE on UPDATE and DELETE", () => {
    expect(() => assertWritable("delete from t", "postgres", { allowDdl: false })).toThrow(/WHERE/);
    expect(() => assertWritable("update t set a = 1", "postgres", { allowDdl: false })).toThrow(/WHERE/);
    expect(() => assertWritable("update t set a = 1 where id = 2", "postgres", { allowDdl: false })).not.toThrow();
    expect(() => assertWritable("delete from t where 1=1", "postgres", { allowDdl: false })).not.toThrow();
  });

  it("gates DDL behind allowDdl", () => {
    expect(() => assertWritable("drop table t", "postgres", { allowDdl: false })).toThrow(/--allow-ddl/);
    expect(() => assertWritable("drop table t", "postgres", { allowDdl: true })).not.toThrow();
  });

  it("sends reads to the query tool", () => {
    expect(() => assertWritable("select 1", "postgres", { allowDdl: true })).toThrow(/query/);
  });
});
