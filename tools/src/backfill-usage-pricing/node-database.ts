import { realpath, stat } from 'node:fs/promises';
import { DatabaseSync } from 'node:sqlite';
import { pathToFileURL } from 'node:url';

import type { DatabaseValue, SqlStatement, StatementResult, ToolDatabase } from './database.ts';
import { inputError } from './errors.ts';

const boundValues = (values: readonly DatabaseValue[] | undefined): never[] =>
  [...(values ?? [])] as never[];

export const openNodeDatabase = async (path: string, mode: 'read' | 'write'): Promise<ToolDatabase> => {
  let info;
  try {
    info = await stat(path);
  } catch {
    throw inputError('node-database-missing', `Node database does not exist: ${path}`);
  }
  if (!info.isFile()) throw inputError('node-database-not-file', `Node database is not a file: ${path}`);

  const canonicalPath = await realpath(path);
  const location = pathToFileURL(canonicalPath);
  location.searchParams.set('mode', mode === 'read' ? 'ro' : 'rw');
  const sqlite = new DatabaseSync(location.href, { readOnly: mode === 'read', timeout: 5000 });
  const openedInfo = await stat(canonicalPath);
  if (info.dev !== openedInfo.dev || info.ino !== openedInfo.ino) {
    sqlite.close();
    throw inputError('node-database-replaced', `Node database changed while it was being opened: ${canonicalPath}`);
  }
  sqlite.exec('PRAGMA foreign_keys = ON');
  sqlite.exec('PRAGMA busy_timeout = 5000');

  const run = <Row>(statement: SqlStatement, query: boolean): StatementResult<Row> => {
    const prepared = sqlite.prepare(statement.sql);
    const params = boundValues(statement.params);
    if (query) return { rows: prepared.all(...params) as Row[], changes: null };
    const result = prepared.run(...params);
    return { rows: [], changes: Number(result.changes) };
  };

  return {
    identity: { kind: 'node', device: Number(openedInfo.dev), inode: Number(openedInfo.ino), path: canonicalPath },
    query: statement => Promise.resolve(run(statement, true)),
    execute: statement => Promise.resolve(run(statement, false)),
    close: () => {
      sqlite.close();
      return Promise.resolve();
    },
  };
};
