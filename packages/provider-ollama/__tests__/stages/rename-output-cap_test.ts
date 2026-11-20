import { test } from 'vitest';

import { prepareOllamaRequest } from '../../src/stages/prepare-request.ts';
import { identityWrapUpstreamCall } from '@floway-dev/provider';
import { assertEquals, collectPreparedProviderRequest, testFetcher, withMockedFetch } from '@floway-dev/test-utils';

// Ollama's shim has no `max_completion_tokens` field, so a cap expressed that
// way never reaches `num_predict`. The rename keeps the caller's number while
// leaving a payload that already speaks the legacy field alone.
test.each([
  { limits: { max_completion_tokens: 0 }, expected: { max_tokens: 0 } },
  { limits: { max_tokens: null, max_completion_tokens: 128000 }, expected: { max_tokens: null, max_completion_tokens: 128000 } },
])('Ollama maps the modern output cap onto its legacy field for $limits', async ({ limits, expected }) => {
  const messages = [{ role: 'user', content: 'hi' }];
  const prepare = prepareOllamaRequest({ baseUrl: 'https://ollama.example', cloudUsage: false, models: [] }, 'openaiChatCompletions');
  let observed: unknown;
  await withMockedFetch(async request => {
    observed = await request.json();
    return Response.json({});
  }, () => collectPreparedProviderRequest(
    prepare, 'openaiChatCompletions', key => key, { method: 'POST', body: JSON.stringify({ messages, ...limits }) },
    { fetcher: testFetcher, wrapUpstreamCall: identityWrapUpstreamCall },
  ));
  assertEquals(observed, { messages, model: 'test-model', stream: true, ...expected });
});
