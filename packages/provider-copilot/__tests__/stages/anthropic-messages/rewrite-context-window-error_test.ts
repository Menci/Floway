import { expect, test } from 'vitest';

import { rewriteCopilotContextWindowError } from '../../../src/stages/anthropic-messages/rewrite-context-window-error.ts';
import { http } from '@floway-dev/http/pipeline';
import { compose, getFailureFacts, move, run } from '@floway-dev/pipeline';
import { decodeProviderResponse, observeProviderCall, type ProviderChatServices } from '@floway-dev/provider';
import { noopUpstreamCallOptions } from '@floway-dev/test-utils';

test('failed finite error-body reading preserves its original failure and the actual call facts', async () => {
  const error = new Error('error response body failed');
  const body = new ReadableStream<Uint8Array>({ start(controller) { controller.error(error); } });
  const services: ProviderChatServices = {
    httpCall: () => ({ ...noopUpstreamCallOptions(), signal: undefined, fetcher: async () => new Response(body, { status: 400 }) }),
    recordProtocolFrames: frames => frames,
  };
  const entry = move({
    'request.provider.modelKey': 'claude-test',
    'request.http.callId': 1,
    'request.http.url': 'https://copilot.example/v1/messages',
    'request.http.method': 'POST',
    'request.http.headers': [],
    'request.http.body': {},
    'request.http.encoding': 'json' as const,
  });
  const pipeline = compose('copilotErrorBody', [rewriteCopilotContextWindowError, decodeProviderResponse('anthropicMessages'), observeProviderCall, http]);
  await expect(run(pipeline, entry, services)).rejects.toBe(error);
  expect(getFailureFacts(error)).toMatchObject({ 'response.provider.called': true, 'response.provider.modelKey': 'claude-test' });
});
