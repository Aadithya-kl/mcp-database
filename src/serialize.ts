const MAX_CELL_CHARS = 2000;

/** Convert driver values into JSON-safe, model-friendly values. */
export function toJsonValue(value: unknown): unknown {
  if (value === null || value === undefined) return null;
  switch (typeof value) {
    case "bigint": {
      const asNumber = Number(value);
      return Number.isSafeInteger(asNumber) ? asNumber : value.toString();
    }
    case "string":
      return value.length > MAX_CELL_CHARS
        ? `${value.slice(0, MAX_CELL_CHARS)}… [truncated, ${value.length} chars]`
        : value;
    case "number":
      return Number.isFinite(value) ? value : String(value);
    case "boolean":
      return value;
    case "object":
      break;
    default:
      return String(value);
  }

  if (value instanceof Date) {
    return Number.isNaN(value.getTime()) ? null : value.toISOString();
  }
  if (value instanceof Uint8Array) {
    const hex = Buffer.from(value.subarray(0, 32)).toString("hex");
    return `<binary ${value.byteLength} bytes${hex ? `: 0x${hex}${value.byteLength > 32 ? "…" : ""}` : ""}>`;
  }
  if (Array.isArray(value)) return value.map(toJsonValue);

  try {
    const json = JSON.stringify(value, (_k, v) => (typeof v === "bigint" ? v.toString() : v));
    if (json === undefined) return String(value);
    return json.length > MAX_CELL_CHARS ? `${json.slice(0, MAX_CELL_CHARS)}… [truncated]` : JSON.parse(json);
  } catch {
    return String(value);
  }
}

export function toJsonRow(row: unknown[]): unknown[] {
  return row.map(toJsonValue);
}

/** Remove connection secrets from an error message before showing it to the model. */
export function redact(message: string, secrets: string[]): string {
  let out = message;
  for (const secret of secrets) {
    if (secret) out = out.split(secret).join("***");
  }
  // postgres://user:pass@host -> postgres://user:***@host
  out = out.replace(/([a-z][a-z0-9+.-]*:\/\/[^:\s/@]+:)[^@\s/]+@/gi, "$1***@");
  return out;
}
