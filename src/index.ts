#!/usr/bin/env node
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { createAdapter } from "./adapters/index.js";
import { ConfigError, HELP, parseConfig } from "./config.js";
import { redact } from "./serialize.js";
import { createServer } from "./server.js";
import { NAME, VERSION } from "./version.js";

async function main(): Promise<void> {
  const parsed = parseConfig(process.argv.slice(2), process.env);
  if (parsed === "help") {
    process.stdout.write(HELP);
    return;
  }
  if (parsed === "version") {
    process.stdout.write(`${NAME} ${VERSION}\n`);
    return;
  }
  const config = parsed;

  const adapter = await createAdapter(config);
  const secrets = [config.url];
  try {
    await adapter.ping();
  } catch (err) {
    await adapter.close().catch(() => {});
    throw new Error(`Could not connect to the ${config.dialect} database: ${redact(err instanceof Error ? err.message : String(err), secrets)}`);
  }

  const server = createServer(adapter, { ...config, secrets });
  const transport = new StdioServerTransport();

  let closing = false;
  const shutdown = async (): Promise<void> => {
    if (closing) return;
    closing = true;
    await server.close().catch(() => {});
    await adapter.close().catch(() => {});
    process.exit(0);
  };
  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);
  process.stdin.on("close", shutdown);

  await server.connect(transport);
  // stdout is reserved for the MCP protocol; log to stderr only.
  console.error(
    `${NAME} ${VERSION} ready: ${config.dialect}, ${config.allowWrites ? (config.allowDdl ? "read-write+ddl" : "read-write") : "read-only"}, max ${config.maxRows} rows`,
  );
}

main().catch((err: unknown) => {
  const message = err instanceof ConfigError ? err.message : err instanceof Error ? err.message : String(err);
  console.error(`${NAME}: ${message}`);
  process.exit(1);
});
