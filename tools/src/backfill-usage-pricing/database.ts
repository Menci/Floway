export type DatabaseValue = null | number | string | Uint8Array;

export interface DatabaseIdentityNode {
  kind: 'node';
  device: number;
  inode: number;
  path: string;
}

export interface DatabaseIdentityD1 {
  kind: 'd1';
  binding: string;
  configPath: string;
  databaseId: string;
  databaseName: string;
  location: 'local' | 'remote';
  persistTo?: string;
}

export type DatabaseIdentity = DatabaseIdentityNode | DatabaseIdentityD1;

export interface SqlStatement {
  sql: string;
  params?: readonly DatabaseValue[];
}

export interface StatementResult<Row = Record<string, unknown>> {
  rows: Row[];
  changes: number | null;
}

export interface ToolDatabase {
  readonly identity: DatabaseIdentity;
  query<Row>(statement: SqlStatement): Promise<StatementResult<Row>>;
  execute(statement: SqlStatement): Promise<StatementResult>;
  close(): Promise<void>;
}
