import { expect, vi } from 'vitest';

import { buildCustomUpstreamRecord, requestAppWithWarmModels, setupAppTest } from '../../../test-utils/app.ts';
import { flushBackground } from '../../../test-utils/background-tracker.ts';
import type { ModelEndpoints } from '@floway-dev/protocols/common';
import { withMockedFetch } from '@floway-dev/test-utils';

export const mountedChatPanic = async (path: string, body: object, endpoints: ModelEndpoints, firstFrame?: Uint8Array) => {
  const { apiKey } = await setupAppTest({
    copilotUpstream: buildCustomUpstreamRecord({
      config: { baseUrl: 'https://upstream.invalid', apiKey: '', ingressHeadersRules: [], endpoints },
    }),
  });
  const cause = new Error('original upstream cause');
  const failure = new RangeError('unexpected upstream panic', { cause });
  const log = vi.spyOn(console, 'error').mockImplementation(() => {});
  let dialed = false;
  try {
    const result = await withMockedFetch(async request => {
      if (new URL(request.url).pathname === '/v1/models') return Response.json({ data: [{ id: 'test-model' }] });
      dialed = true;
      if (firstFrame === undefined) throw failure;
      let sent = false;
      return new Response(new ReadableStream<Uint8Array>({
        pull(output) {
          if (sent) {
            output.error(failure);
          } else {
            sent = true;
            output.enqueue(firstFrame);
          }
        },
      }, { highWaterMark: 0 }), { headers: { 'content-type': 'text/event-stream' } });
    }, async () => {
      const response = await requestAppWithWarmModels(path, {
        method: 'POST',
        headers: { authorization: `Bearer ${apiKey.key}`, 'content-type': 'application/json' },
        body: JSON.stringify(body),
      });
      return { status: response.status, text: await response.text() };
    });
    await flushBackground();
    expect(dialed).toBe(true);
    expect(log.mock.calls.find(([tag]) => tag === '[pipeline-response]')?.[1]).toBe(failure);
    return { ...result, failure, cause };
  } finally {
    log.mockRestore();
  }
};
