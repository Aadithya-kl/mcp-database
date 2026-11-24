import { execFileSync, spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { DatabaseSync } from "node:sqlite";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

// Spawns the real, built CLI over stdio — exactly how an MCP client (Claude Desktop, Cursor, ...) runs it.
const root = fileURLToPath(new URL("..", import.meta.url));
const bin = join(root, "dist", "index.js");
let dir: string;
let file: string;

beforeAll(() => {
  execFileSync("npx", ["tsup"], { cwd: root, stdio: "ignore" });
  expect(existsSync(bin)).toBe(true);
  dir = mkdtempSync(join(tmpdir(), "mcp-database-e2e-"));
  file = join(dir, "e2e.db");
  const db = new DatabaseSync(file);
  db.exec("CREATE TABLE t (id INTEGER PRIMARY KEY, v TEXT); INSERT INTO t (v) VALUES ('a'), ('b');");
  db.close();
}, 120_000);

afterAll(() => {
  if (dir) rmSync(dir, { recursive: true, force: true });
});

describe("cli over stdio", () => {
  it("initialises, lists tools and answers a query", async () => {
    const transport = new StdioClientTransport({
      command: process.execPath,
      args: [bin],
      env: { PATH: process.env.PATH ?? "", DATABASE_URL: `sqlite://${file}` },
      stderr: "pipe",
    });
    const client = new Client({ name: "e2e", version: "1.0.0" });
    await client.connect(transport);
    try {
      expect(client.getServerVersion()?.name).toBe("mcp-database");
      expect(client.getInstructions()).toMatch(/sqlite database in read-only mode/);
      const tools = (await client.listTools()).tools;
      expect(tools.map((t) => t.name).sort()).toEqual(["describe_table", "list_schemas", "list_tables", "query", "sample_rows"]);
      expect(tools.find((t) => t.name === "query")?.annotations?.readOnlyHint).toBe(true);

      const res = await client.callTool({ name: "query", arguments: { sql: "SELECT v FROM t ORDER BY id" } });
      const text = (res.content as Array<{ text: string }>)[0]!.text;
      expect(JSON.parse(text).rows).toEqual([["a"], ["b"]]);

      const blocked = await client.callTool({ name: "query", arguments: { sql: "DROP TABLE t" } });
      expect(blocked.isError).toBe(true);
    } finally {
      await client.close();
    }
  }, 30_000);

  it("exposes execute only with --read-write", async () => {
    const transport = new StdioClientTransport({
      command: process.execPath,
      args: [bin, "--read-write"],
      env: { PATH: process.env.PATH ?? "", DATABASE_URL: file },
    });
    const client = new Client({ name: "e2e", version: "1.0.0" });
    await client.connect(transport);
    try {
      const names = (await client.listTools()).tools.map((t) => t.name);
      expect(names).toContain("execute");
    } finally {
      await client.close();
    }
  }, 30_000);

  it("fails fast without leaking the password", () => {
    const run = spawnSync(process.execPath, [bin], {
      env: { PATH: process.env.PATH ?? "", DATABASE_URL: "postgres://bob:hunter2@127.0.0.1:1/nope" },
      encoding: "utf8",
      timeout: 20_000,
    });
    expect(run.status).toBe(1);
    expect(run.stderr).toMatch(/Could not connect to the postgres database/);
    expect(run.stderr).not.toMatch(/hunter2/);
    expect(run.stdout).toBe("");
  });

  it("prints help and version", () => {
    expect(spawnSync(process.execPath, [bin, "--version"], { encoding: "utf8" }).stdout).toMatch(/^mcp-database \d+\.\d+\.\d+/);
    expect(spawnSync(process.execPath, [bin, "--help"], { encoding: "utf8" }).stdout).toMatch(/--read-write/);
  });
});
