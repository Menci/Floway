import { Hono } from 'hono';
import { expect, test, vi } from 'vitest';

import type { AuthVars } from '../../../../../src/middleware/auth.ts';
import { initRepo } from '../../../../../src/repo/index.ts';
import type { ApiKey, User } from '../../../../../src/repo/types.ts';
import { InMemoryRepo } from '../../../../repo/memory.ts';
import { flushBackground } from '../../../../test-utils/background-tracker.ts';
import type { AnthropicMessagesPayload, AnthropicMessagesStreamEventEx } from '@floway-dev/protocols/anthropic-messages';
import { eventFrame } from '@floway-dev/protocols/common';
import { collectOpenAIChatCompletionsProtocolEventsToResult, parseOpenAIChatCompletionsStream, type OpenAIChatCompletionsPayload, type OpenAIChatCompletionsResult } from '@floway-dev/protocols/openai-chat-completions';
import type { ModelCandidate } from '@floway-dev/provider';
import { stubModelCandidate, stubProvider } from '@floway-dev/test-utils';

let selected: ModelCandidate;
vi.mock('../../../../../src/data-plane/providers/resolution.ts', async importOriginal => ({
  ...await importOriginal<typeof import('../../../../../src/data-plane/providers/resolution.ts')>(),
  enumerateModelCandidates: async () => ({ candidates: [selected], sawModel: true, failedUpstreams: [] }),
}));
const { openaiChatCompletionsHttp } = await import('../../../../../src/data-plane/chat/openai-chat-completions/http.ts');
const apiKey: ApiKey = { id: 'key', userId: 1, name: 'key', key: 'sk-test', serverSecret: '22'.repeat(32), createdAt: '2026-01-01T00:00:00Z', upstreamIds: null, deletedAt: null, dumpRetentionSeconds: null, openaiResponsesRetentionSeconds: 0 };
const user: User = { id: 1, username: 'test', passwordHash: null, isAdmin: false, upstreamIds: null, createdAt: apiKey.createdAt, deletedAt: null };
const app = new Hono<{ Variables: AuthVars }>();
app.use('*', async (c, next) => { c.set('apiKey', apiKey); c.set('user', user); await next(); });
app.post('/v1/chat/completions', openaiChatCompletionsHttp.generate);

test.each([false, true])('Messages reasoning survives a complete native upstream HTTP replay with stream=%s', async stream => {
  initRepo(new InMemoryRepo());
  const requests: Array<Omit<AnthropicMessagesPayload, 'model'>> = [];
  const blocks = [{ type: 'thinking', thinking: 'AB', signature: 'native-sig' }, { type: 'redacted_thinking', data: 'native-redacted' }];
  const provider = stubProvider({
    callAnthropicMessages: async (_model, body) => {
      requests.push(body);
      const events = (async function* () {
        yield eventFrame({ type: 'message_start', message: { container: null, diagnostics: null, stop_details: null, id: 'msg_1', type: 'message', model: 'model', role: 'assistant', content: [], usage: { cache_creation: null, cache_creation_input_tokens: null, cache_read_input_tokens: null, inference_geo: null, output_tokens_details: null, server_tool_use: null, service_tier: null, input_tokens: 3, output_tokens: 0 }, stop_reason: null, stop_sequence: null } } as AnthropicMessagesStreamEventEx);
        yield eventFrame({ type: 'content_block_start', index: 0, content_block: { type: 'thinking', thinking: '' } } as AnthropicMessagesStreamEventEx);
        for (const thinking of ['A', 'B']) yield eventFrame({ type: 'content_block_delta', index: 0, delta: { type: 'thinking_delta', thinking } } as AnthropicMessagesStreamEventEx);
        yield eventFrame({ type: 'content_block_delta', index: 0, delta: { type: 'signature_delta', signature: 'native-sig' } } as AnthropicMessagesStreamEventEx);
        yield eventFrame({ type: 'content_block_stop', index: 0 } as AnthropicMessagesStreamEventEx);
        yield eventFrame({ type: 'content_block_start', index: 1, content_block: blocks[1] } as AnthropicMessagesStreamEventEx);
        yield eventFrame({ type: 'content_block_stop', index: 1 } as AnthropicMessagesStreamEventEx);
        yield eventFrame({ type: 'content_block_start', index: 2, content_block: { type: 'text', text: '' } } as AnthropicMessagesStreamEventEx);
        yield eventFrame({ type: 'content_block_delta', index: 2, delta: { type: 'text_delta', text: 'answer' } } as AnthropicMessagesStreamEventEx);
        yield eventFrame({ type: 'content_block_stop', index: 2 } as AnthropicMessagesStreamEventEx);
        yield eventFrame({ type: 'message_delta', delta: { container: null, stop_details: null, stop_sequence: null, stop_reason: 'end_turn' }, usage: { input_tokens: null, cache_creation_input_tokens: null, cache_read_input_tokens: null, output_tokens_details: null, server_tool_use: null, output_tokens: 2 } } as AnthropicMessagesStreamEventEx);
        yield eventFrame({ type: 'message_stop' } as AnthropicMessagesStreamEventEx);
      })();
      return { ok: true, events, modelKey: 'key', headers: new Headers({ 'x-native': 'kept' }) };
    },
  });
  selected = stubModelCandidate({ model: { id: 'model', endpoints: { anthropicMessages: {} } }, provider: { ...stubModelCandidate().provider, instance: provider } });
  const call = async (messages: OpenAIChatCompletionsPayload['messages']) => {
    const result = await app.request('/v1/chat/completions', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ model: 'model', stream, stream_options: { include_usage: true }, messages }) });
    expect(result.status, await result.clone().text()).toBe(200);
    expect(result.headers.get('x-native')).toBe('kept');
    return stream ? await collectOpenAIChatCompletionsProtocolEventsToResult(parseOpenAIChatCompletionsStream(result.body!)) : await result.json() as OpenAIChatCompletionsResult;
  };
  const first = await call([{ role: 'user', content: 'hello' }]);
  expect(first.choices[0].message).toMatchObject({ content: 'answer', reasoning: 'AB' });
  expect(first.usage).toMatchObject({ prompt_tokens: 3, completion_tokens: 2, total_tokens: 5 });
  await call([first.choices[0].message, { role: 'user', content: 'continue' }]);
  expect(requests[1].messages[0]).toMatchObject({ role: 'assistant', content: [...blocks, { type: 'text', text: 'answer' }] });
  expect(requests[1].messages[1]).toMatchObject({ role: 'user' });
  await flushBackground();
});
