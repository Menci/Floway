import { DatabaseSync } from 'node:sqlite';

import { test } from 'vitest';

import { migrationSqlByFilename } from '../repo/test-sqlite.ts';
import { assertEquals } from '@floway-dev/test-utils';

test('dump body encoding migration marks every existing body as gzip', () => {
  const db = new DatabaseSync(':memory:');
  for (const [filename, sql] of migrationSqlByFilename) {
    if (filename === '0080_dump_body_encoding.sql') {
      db.prepare(`INSERT INTO dump_records
        (key_id, id, created_at, meta_json, request_headers_json, response_headers_json, request_body_descriptor, response_body_descriptor)
        VALUES (?, ?, 1, '{}', '[]', '[]', ?, ?)`)
        .run(
          'key',
          'record',
          JSON.stringify({ key: 'dumps/v1/key/request.gz', type: 'bytes' }),
          JSON.stringify({ key: 'dumps/v1/key/response.gz', type: 'events' }),
        );
    }
    db.exec(sql);
  }

  const row = db.prepare(`SELECT request_body_descriptor, response_body_descriptor
    FROM dump_records WHERE key_id = 'key' AND id = 'record'`).get() as {
    request_body_descriptor: string;
    response_body_descriptor: string;
  };
  db.close();

  assertEquals(JSON.parse(row.request_body_descriptor), {
    key: 'dumps/v1/key/request.gz',
    type: 'bytes',
    encoding: 'gzip',
  });
  assertEquals(JSON.parse(row.response_body_descriptor), {
    key: 'dumps/v1/key/response.gz',
    type: 'events',
    encoding: 'gzip',
  });
});
