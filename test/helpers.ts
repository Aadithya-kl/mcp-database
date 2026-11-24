import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { createServer, type ServerOptions } from "../src/server.js";
import type { Adapter } from "../src/types.js";

export interface Harness {
  client: Client;
  close: () => Promise<void>;
  /** Calls a tool and returns the parsed JSON (or the raw error text). */
  call: (name: string, args?: Record<string, unknown>) => Promise<{ isError: boolean; data: any; text: string }>;
  toolNames: () => Promise<string[]>;
}

export async function connect(adapter: Adapter, opts: Partial<ServerOptions> = {}): Promise<Harness> {
  const server = createServer(adapter, {
    allowWrites: false,
    allowDdl: false,
    maxRows: 200,
    timeoutMs: 15_000,
    ...opts,
  });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: "test-client", version: "1.0.0" });
  await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);

  return {
    client,
    close: async () => {
      await client.close();
      await server.close();
    },
    toolNames: async () => (await client.listTools()).tools.map((t) => t.name).sort(),
    call: async (name, args = {}) => {
      const res = await client.callTool({ name, arguments: args });
      const text = (res.content as Array<{ type: string; text: string }>).map((c) => c.text).join("\n");
      let data: any = undefined;
      try {
        data = JSON.parse(text);
      } catch {
        /* error text */
      }
      return { isError: Boolean(res.isError), data, text };
    },
  };
}
