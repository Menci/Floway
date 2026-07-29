// Minimal SQL database contract used by the gateway's repo layer. Cloudflare's
// D1 satisfies the shape directly. `meta.changes` is the only metadata field
// the contract requires; runtime-specific fields (D1's duration, rows_read,
// rows_written) intentionally stay out of the platform surface.
export interface SqlResult<T = Record<string, unknown>> {
  results: T[];
  success: boolean;
  meta: SqlResultMeta;
}

export interface SqlResultMeta {
  changes?: number;
}

// The value types every deployment target accepts as a bound parameter. The
// two targets disagree at the edges, so the contract is their intersection and
// callers normalize anything else themselves. D1 coerces a boolean to 1/0 and
// rejects bigint; node:sqlite rejects booleans outright — deliberately, since
// it could not read the original type back — and takes bigint for INTEGER
// affinity. Neither accepts undefined.
// https://developers.cloudflare.com/d1/worker-api/#type-conversion
// https://github.com/cloudflare/workerd/blob/773b22265b07894b91d28c0d5358c7b1d503d79e/src/cloudflare/internal/d1-api.ts#L483-L518
// https://nodejs.org/api/sqlite.html#type-conversion-between-javascript-and-sqlite
// https://github.com/nodejs/node/blob/9de263aa8831941561f7e29aa1c13b03ceeba878/src/node_sqlite.cc#L2692-L2747
export type SqlBindValue = null | number | string | Uint8Array;

export interface SqlPreparedStatement {
  bind(...values: SqlBindValue[]): SqlPreparedStatement;
  first<T = Record<string, unknown>>(): Promise<T | null>;
  all<T = Record<string, unknown>>(): Promise<SqlResult<T>>;
  run(): Promise<SqlResult>;
}

export interface SqlDatabase {
  prepare(query: string): SqlPreparedStatement;
  batch?(statements: SqlPreparedStatement[]): Promise<SqlResult[]>;
  // Execute a SQL string that may contain multiple statements. Used by
  // migration runners that need to apply hand-authored DDL files where a
  // single statement contains a `;` (e.g. CREATE TRIGGER ... BEGIN ... END;)
  // and a per-statement bind/run loop would mangle the body. Returns
  // a runtime-defined value the contract does not promise to expose.
  exec(sql: string): Promise<unknown>;
}
