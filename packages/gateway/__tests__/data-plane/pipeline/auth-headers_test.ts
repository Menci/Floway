import { expect, test } from 'vitest';

import { hostFor } from './fixtures.ts';
import { stripAuthenticationHeaders } from '../../../src/data-plane/pipeline/auth-headers.ts';
import type { HttpRequestFact } from '@floway-dev/http';
import { asEntry, factSpace, run, secret } from '@floway-dev/pipeline';

test('strips Floway credentials while preserving header multiplicity and original body bytes', async () => {
  const { defineStage, compose } = factSpace<{ http: HttpRequestFact }, { received: HttpRequestFact }>();
  const ending = defineStage({
    name: 'read-upstream-request', request: { needs: ['http'] }, return: { provides: ['received'] },
    async execute({ http }) { return { received: http }; },
  });
  const entry = asEntry(compose('authenticate', {
    entry: ['http'], exit: ['received'], stages: [stripAuthenticationHeaders], ending,
  }));
  const body = new Uint8Array([0x42]);
  const kept = secret('upstream extension');
  const http: HttpRequestFact = {
    method: 'POST', url: 'https://floway.invalid/v1/responses', body,
    headers: [
      ['Authorization', secret('floway key')],
      ['X-API-Key', 'floway key'],
      ['X-Goog-Api-Key', 'floway key'],
      ['x-floway-session', 'session'],
      ['X-Extension', kept],
      ['x-extension', 'second value'],
    ],
  };
  const host = hostFor({});
  const running = run(entry, { http }, host.options);
  const answer = await running.result;
  expect(answer.received.headers).toEqual([['X-Extension', kept], ['x-extension', 'second value']]);
  expect(answer.received.headers[0]).toBe(http.headers[4]);
  expect(answer.received.body).toBe(body);
  expect(http.headers).toHaveLength(6);
  host.controller.abort();
  running.discard(answer);
});
