import { Hono } from 'hono';
import { expect, test, vi } from 'vitest';

import type { AuthVars } from '../../../../src/middleware/auth.ts';
import { initRepo } from '../../../../src/repo/index.ts';
import type { ApiKey, User } from '../../../../src/repo/types.ts';
import { InMemoryRepo } from '../../../repo/memory.ts';
import { flushBackground } from '../../../test-utils/background-tracker.ts';
import { collectAnthropicMessagesProtocolEventsToResult, parseAnthropicMessagesStream, type AnthropicMessagesPayload, type AnthropicMessagesMessage, type AnthropicMessagesResult } from '@floway-dev/protocols/anthropic-messages';
import { eventFrame } from '@floway-dev/protocols/common';
import type { OpenAIChatCompletionsPayload, OpenAIChatCompletionsStreamEvent, OpenAIChatCompletionsAssistantMessageEx } from '@floway-dev/protocols/openai-chat-completions';
import { openaiResponsesResultToEvents, type CanonicalOpenAIResponsesInputItem, type OpenAIResponsesResultEx } from '@floway-dev/protocols/openai-responses';
import type { ModelCandidate } from '@floway-dev/provider';
import { stubModelCandidate, stubProvider } from '@floway-dev/test-utils';

let selected: ModelCandidate;
vi.mock('../../../../src/data-plane/providers/resolution.ts', async importOriginal => ({
  ...await importOriginal<typeof import('../../../../src/data-plane/providers/resolution.ts')>(),
  enumerateModelCandidates: async () => ({ candidates: [selected], sawModel: true, failedUpstreams: [] }),
}));
const { anthropicMessagesHttp } = await import('../../../../src/data-plane/chat/anthropic-messages/http.ts');
const apiKey: ApiKey = { id: 'key', userId: 1, name: 'key', key: 'sk-test', serverSecret: '22'.repeat(32), createdAt: '2026-01-01T00:00:00Z', upstreamIds: null, deletedAt: null, dumpRetentionSeconds: null, openaiResponsesRetentionSeconds: 0 };
const user: User = { id: 1, username: 'test', passwordHash: null, isAdmin: false, upstreamIds: null, createdAt: apiKey.createdAt, deletedAt: null };
const app = new Hono<{ Variables: AuthVars }>();
app.use('*', async (c, next) => { c.set('apiKey', apiKey); c.set('user', user); await next(); });
app.post('/v1/messages', anthropicMessagesHttp.generate);
app.post('/v1/messages/count_tokens', anthropicMessagesHttp.countTokens);

test.each([false, true])('Messages via Chat replays the final redacted carrier even without display thinking with stream=%s', async stream => {
  initRepo(new InMemoryRepo());
  const requests: Array<Omit<OpenAIChatCompletionsPayload, 'model'>> = [];
  const provider = stubProvider({
    callOpenAIChatCompletions: async (_model, body) => {
      requests.push(body);
      const events = (async function* () {
        const deltas = [{ reasoning_content: 'A' }, { content: 'answer' }, { reasoning_content: 'B' }, { reasoning_opaque: 'native-cipher' }];
        for (const delta of deltas) yield eventFrame({ id: 'chat', object: 'chat.completion.chunk', model: 'model', created: 1, choices: [{ index: 0, delta, finish_reason: null }] } as OpenAIChatCompletionsStreamEvent);
        yield eventFrame({ id: 'chat', object: 'chat.completion.chunk', model: 'model', created: 1, choices: [{ index: 0, delta: {}, finish_reason: 'stop' }], usage: { prompt_tokens: 3, completion_tokens: 2, total_tokens: 5 } } as OpenAIChatCompletionsStreamEvent);
      })();
      return { ok: true, events, modelKey: 'key', headers: new Headers({ 'x-native': 'kept' }) };
    },
  });
  selected = stubModelCandidate({ model: { id: 'model', endpoints: { openaiChatCompletions: {} } }, provider: { ...stubModelCandidate().provider, instance: provider } });
  const call = async (messages: AnthropicMessagesMessage[]) => {
    const result = await app.request('/v1/messages', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ model: 'model', stream, max_tokens: 100, messages }) });
    expect(result.status, await result.clone().text()).toBe(200);
    expect(result.headers.get('x-native')).toBe('kept');
    return stream ? await collectAnthropicMessagesProtocolEventsToResult(parseAnthropicMessagesStream(result.body!)) : await result.json() as AnthropicMessagesResult;
  };
  const first = await call([{ role: 'user', content: 'hello' }]);
  expect(first.content.map(block => block.type)).toEqual(['thinking', 'text', 'thinking', 'redacted_thinking']);
  expect(first.usage).toMatchObject({ input_tokens: 3, output_tokens: 2 });
  await call([{ role: 'assistant', content: first.content.filter(block => block.type !== 'thinking') }, { role: 'user', content: 'continue' }]);
  expect(requests[1].messages[0] as OpenAIChatCompletionsAssistantMessageEx).toMatchObject({ role: 'assistant', content: 'answer', reasoning_content: 'AB', reasoning_opaque: 'native-cipher' });
  const originalUpstreamId = selected.provider.upstreamId;
  const countInputs: AnthropicMessagesPayload['messages'][] = [];
  const responseInputs: CanonicalOpenAIResponsesInputItem[][] = [];
  const messagesInputs: AnthropicMessagesPayload['messages'][] = [];
  const fallbackProvider = stubProvider({
    callAnthropicMessagesCountTokens: async (_model, body) => {
      countInputs.push(body.messages);
      return { response: Response.json({ input_tokens: 1 }), modelKey: 'key' };
    },
    callOpenAIResponses: async (_model, body) => {
      responseInputs.push(body.input);
      const response: OpenAIResponsesResultEx = { id: 'resp-native', object: 'response', model: 'model', status: 'completed', error: null, incomplete_details: null, output: [] };
      return { ok: true, action: 'generate', modelKey: 'key', headers: new Headers({ 'x-native': 'kept' }), events: (async function* () { yield* openaiResponsesResultToEvents(response); })() };
    },
    callAnthropicMessages: async (_model, body) => {
      messagesInputs.push(body.messages);
      return {
        ok: true, modelKey: 'key', headers: new Headers({ 'x-native': 'kept' }), events: (async function* () {
          yield eventFrame({ type: 'message_start' as const, message: { container: null, diagnostics: null, stop_details: null, id: 'msg-native', type: 'message' as const, role: 'assistant' as const, model: 'model', content: [] as [], stop_reason: null, stop_sequence: null, usage: { cache_creation: null, cache_creation_input_tokens: null, cache_read_input_tokens: null, inference_geo: null, output_tokens_details: null, server_tool_use: null, service_tier: null, input_tokens: 1, output_tokens: 0 } } });
          yield eventFrame({ type: 'message_delta' as const, delta: { container: null, stop_details: null, stop_reason: 'end_turn' as const, stop_sequence: null }, usage: { input_tokens: null, cache_creation_input_tokens: null, cache_read_input_tokens: null, output_tokens_details: null, server_tool_use: null, output_tokens: 0 } });
          yield eventFrame({ type: 'message_stop' as const });
        })(),
      };
    },
  });
  for (const target of ['openaiResponses', 'anthropicMessages'] as const) {
    for (const upstreamId of [originalUpstreamId, 'fallback']) {
      selected = stubModelCandidate({ model: { id: 'model', endpoints: { [target]: {} } }, provider: { ...stubModelCandidate().provider, upstreamId, instance: fallbackProvider } });
      await call([{ role: 'assistant', content: first.content }, { role: 'user', content: 'continue' }]);
    }
  }
  for (const input of responseInputs) expect(input.map(item => item.type)).toEqual(['message', 'message']);
  for (const input of messagesInputs) {
    expect(input).toMatchObject([{ role: 'assistant', content: [{ type: 'text', text: 'answer' }] }, { role: 'user', content: 'continue' }]);
    expect(JSON.stringify(input)).not.toContain('thinking');
  }
  selected = stubModelCandidate({ model: { id: 'model', endpoints: { anthropicMessages: {} } }, provider: { ...stubModelCandidate().provider, upstreamId: originalUpstreamId, instance: fallbackProvider } });
  const counted = await app.request('/v1/messages/count_tokens', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ model: 'model', messages: [{ role: 'assistant', content: first.content }, { role: 'user', content: 'continue' }] }) });
  expect(counted.status, await counted.clone().text()).toBe(200);
  expect(await counted.json()).toEqual({ input_tokens: 1 });
  expect(countInputs[0]).toMatchObject([{ role: 'assistant', content: [{ type: 'text', text: 'answer' }] }, { role: 'user', content: 'continue' }]);
  expect(JSON.stringify(countInputs)).not.toContain('thinking');
  await flushBackground();
});
