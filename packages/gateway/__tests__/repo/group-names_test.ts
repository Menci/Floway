import { expect, test } from 'vitest';

import { createSqliteTestDb } from './test-sqlite.ts';
import { groupNameKey } from '../../src/repo/group-names.ts';

test('group name keys have the same equality as SQLite NOCASE, including embedded NUL', async () => {
  const db = await createSqliteTestDb();
  const encoder = new TextEncoder();
  const names = ['Ops', 'ops', '\u00c4', '\u00e4', '\u03a3', '\u03c3', 'TEAM-\u00c4', 'team-\u00c4', 'a\0x', 'A\0y', 'a\0yz', 'a\0\u00e4'];
  for (const left of names) {
    for (const right of names) {
      const result = await db.prepare('SELECT CAST(? AS TEXT) = CAST(? AS TEXT) COLLATE NOCASE AS equal')
        .bind(encoder.encode(left), encoder.encode(right)).first<{ equal: number }>();
      expect(groupNameKey(left) === groupNameKey(right), JSON.stringify([left, right])).toBe(result!.equal === 1);
    }
  }
});
