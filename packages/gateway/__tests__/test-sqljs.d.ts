declare module 'sql.js' {
  export interface SqlJsDatabase {
    create_function(name: string, fn: (...args: never[]) => unknown): void;
    run(sql: string, params?: unknown[]): void;
    exec(sql: string, params?: unknown[]): Array<{ columns: string[]; values: unknown[][] }>;
    export(): Uint8Array;
    close(): void;
  }

  export interface SqlJsStatic {
    Database: new (data?: Uint8Array) => SqlJsDatabase;
  }

  const initSqlJs: () => Promise<SqlJsStatic>;

  export default initSqlJs;
}

interface ImportMeta {
  glob(pattern: string, options: { query: '?raw'; import: 'default'; eager: true }): Record<string, string>;
}
