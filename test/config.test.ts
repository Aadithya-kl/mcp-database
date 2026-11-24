import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { ConfigError, detectDialect, parseConfig } from "../src/config.js";
import { redact } from "../src/serialize.js";
import { NAME, VERSION } from "../src/version.js";

describe("version", () => {
  it("matches package.json", () => {
    const pkg = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8"));
    expect(VERSION).toBe(pkg.version);
    expect(pkg.name.endsWith(NAME)).toBe(true);
    expect(pkg.mcpName).toMatch(/\/mcp-database$/);
  });
});

describe("detectDialect", () => {
  it.each([
    ["postgres://u:p@h/db", "postgres", "postgres://u:p@h/db"],
    ["postgresql://u:p@h/db", "postgres", "postgresql://u:p@h/db"],
    ["mysql://u:p@h/db", "mysql", "mysql://u:p@h/db"],
    ["mariadb://u:p@h/db", "mysql", "mysql://u:p@h/db"],
    ["sqlite:///abs/app.db", "sqlite", "/abs/app.db"],
    ["sqlite://:memory:", "sqlite", ":memory:"],
    ["sqlite:rel/app.db", "sqlite", "rel/app.db"],
    ["./data/app.sqlite3", "sqlite", "./data/app.sqlite3"],
    [":memory:", "sqlite", ":memory:"],
  ])("%s", (input, dialect, url) => {
    expect(detectDialect(input)).toEqual({ dialect, url });
  });

  it("rejects unsupported schemes", () => {
    expect(() => detectDialect("mongodb://x")).toThrow(ConfigError);
    expect(() => detectDialect("sqlite:")).toThrow(ConfigError);
  });
});

describe("parseConfig", () => {
  it("defaults to read-only with sane limits", () => {
    const cfg = parseConfig([], { DATABASE_URL: "postgres://u:p@h/db" });
    expect(cfg).toMatchObject({ dialect: "postgres", allowWrites: false, allowDdl: false, maxRows: 200, timeoutMs: 15000 });
  });

  it("prefers --url / positional over the environment", () => {
    expect(parseConfig(["--url", "mysql://a@h/d"], { DATABASE_URL: "postgres://u@h/d" })).toMatchObject({ dialect: "mysql" });
    expect(parseConfig(["sqlite:///x.db"], { DATABASE_URL: "postgres://u@h/d" })).toMatchObject({ dialect: "sqlite" });
  });

  it("reads flags and environment toggles", () => {
    expect(parseConfig(["--read-write", "--allow-ddl", "--max-rows", "10", "--timeout-ms", "500"], { DATABASE_URL: "x.db" })).toMatchObject({
      allowWrites: true,
      allowDdl: true,
      maxRows: 10,
      timeoutMs: 500,
    });
    expect(parseConfig([], { DATABASE_URL: "x.db", MCP_DATABASE_READ_WRITE: "true" })).toMatchObject({ allowWrites: true });
  });

  it("validates input", () => {
    expect(() => parseConfig([], {})).toThrow(/No database configured/);
    expect(() => parseConfig(["--allow-ddl"], { DATABASE_URL: "x.db" })).toThrow(/requires --read-write/);
    expect(() => parseConfig(["--max-rows", "0"], { DATABASE_URL: "x.db" })).toThrow(/max-rows/);
    expect(() => parseConfig(["--max-rows", "abc"], { DATABASE_URL: "x.db" })).toThrow(/max-rows/);
    expect(() => parseConfig(["--timeout-ms", "5"], { DATABASE_URL: "x.db" })).toThrow(/timeout-ms/);
  });

  it("handles --help and --version", () => {
    expect(parseConfig(["--help"], {})).toBe("help");
    expect(parseConfig(["-v"], {})).toBe("version");
  });
});

describe("redact", () => {
  it("removes secrets and URL passwords", () => {
    expect(redact("connect failed postgres://bob:hunter2@db.example.com/app", [])).toBe("connect failed postgres://bob:***@db.example.com/app");
    expect(redact("password hunter2 rejected", ["hunter2"])).toBe("password *** rejected");
  });
});
