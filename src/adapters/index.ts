import type { Config } from "../config.js";
import type { Adapter } from "../types.js";
import { MysqlAdapter } from "./mysql.js";
import { PostgresAdapter } from "./postgres.js";
import { SqliteAdapter } from "./sqlite.js";

export async function createAdapter(config: Pick<Config, "dialect" | "url" | "allowWrites">, poolSize?: number): Promise<Adapter> {
  switch (config.dialect) {
    case "postgres":
      return new PostgresAdapter({ url: config.url, poolSize });
    case "mysql":
      return new MysqlAdapter({ url: config.url, poolSize });
    case "sqlite":
      return SqliteAdapter.open({ path: config.url, writable: config.allowWrites });
  }
}
