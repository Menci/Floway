import { expect, test } from 'vitest';

import { facts, fixture } from './fixture.ts';
import { alphaSearchIngress } from '../../../../../src/data-plane/alpha-search/pipeline.ts';
import { writeHttpResponse } from '../../../../../src/data-plane/shared/http-writer.ts';
import { run } from '@floway-dev/pipeline';

test.each([
  { status: 202, statusText: 'Accepted upstream', body: '{"output":"decoded"}', contentType: 'application/json' },
  { status: 503, statusText: 'Unavailable upstream', body: 'upstream error', contentType: 'text/plain' },
])('Alpha Search relays decoded bytes and representation-safe headers for upstream HTTP $status', async ({ status, statusText, body, contentType }) => {
  const { services } = fixture(() => new Response(body, {
    status,
    statusText,
    headers: [
      ['connection', 'close'], ['content-encoding', 'gzip'], ['content-length', '999'],
      ['content-type', contentType], ['set-cookie', 'session=upstream-secret'],
      ['transfer-encoding', 'chunked'], ['x-oai-request-id', 'req_search_1'],
    ],
  }));
  const handle = run(alphaSearchIngress, facts, { services, finalizationTimeoutMs: 100 });
  const response = writeHttpResponse((await handle.result)['response.http']);
  expect(response.status).toBe(status);
  expect(response.statusText).toBe(statusText);
  expect(await response.text()).toBe(body);
  expect([...response.headers]).toEqual([['content-type', contentType], ['x-oai-request-id', 'req_search_1']]);
  expect(await handle.done).toEqual({ ok: true });
});
