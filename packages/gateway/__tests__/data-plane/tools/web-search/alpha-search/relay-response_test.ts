import { expect, test } from 'vitest';

import { forwardHttp } from '../../../../../src/data-plane/pipeline/non-chat.ts';
import { writeHttpResponse } from '../../../../../src/data-plane/shared/http-writer.ts';
import { wrapSensitiveHeaderEntries } from '@floway-dev/http';
import { Bytes } from '@floway-dev/pipeline';

test('Alpha Search relays decoded bytes and representation-safe upstream headers', async () => {
  const body = JSON.stringify({ output: 'decoded' });
  const response = writeHttpResponse(forwardHttp({
    status: 202,
    statusText: 'Accepted upstream',
    timing: { startedAt: 0, headersAt: 1 },
    body: Bytes.fromUtf8(body),
    headers: wrapSensitiveHeaderEntries([
      ['connection', 'close'], ['content-encoding', 'gzip'], ['content-length', '999'],
      ['content-type', 'application/json'], ['set-cookie', 'session=upstream-secret'],
      ['transfer-encoding', 'chunked'], ['x-oai-request-id', 'req_search_1'],
    ]),
  }, null));
  expect(response.status).toBe(202);
  expect(response.statusText).toBe('Accepted upstream');
  expect(await response.text()).toBe(body);
  expect([...response.headers]).toEqual([['content-type', 'application/json'], ['x-oai-request-id', 'req_search_1']]);
});
