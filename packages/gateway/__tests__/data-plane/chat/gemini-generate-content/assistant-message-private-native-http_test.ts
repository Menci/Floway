import { Hono } from 'hono';
import { expect, test, vi } from 'vitest';

import type { AuthVars } from '../../../../src/middleware/auth.ts';
import { initRepo } from '../../../../src/repo/index.ts';
import type { ApiKey, User } from '../../../../src/repo/types.ts';
import { InMemoryRepo } from '../../../repo/memory.ts';
import { flushBackground } from '../../../test-utils/background-tracker.ts';
import { type AnthropicMessagesPayload, type AnthropicMessagesResult } from '@floway-dev/protocols/anthropic-messages';
import { eventFrame, parseSSEStream } from '@floway-dev/protocols/common';
import { collectGeminiGenerateContentProtocolEventsToResult, type GeminiGenerateContentContent, type GeminiGenerateContentResult, type GeminiGenerateContentStreamEvent } from '@floway-dev/protocols/gemini-generate-content';
import { openaiResponsesResultToEvents, type CanonicalOpenAIResponsesInputItem, type OpenAIResponsesResultEx } from '@floway-dev/protocols/openai-responses';
import type { ModelCandidate } from '@floway-dev/provider';
import { stubModelCandidate, stubProvider } from '@floway-dev/test-utils';

let selected: ModelCandidate;
vi.mock('../../../../src/data-plane/providers/resolution.ts', async importOriginal => ({
  ...await importOriginal<typeof import('../../../../src/data-plane/providers/resolution.ts')>(),
  enumerateModelCandidates: async () => ({ candidates: [selected], sawModel: true, failedUpstreams: [] }),
}));
const { geminiGenerateContentHttp } = await import('../../../../src/data-plane/chat/gemini-generate-content/http.ts');
const apiKey: ApiKey = { id: 'key', userId: 1, name: 'key', key: 'sk-test', serverSecret: '22'.repeat(32), createdAt: '2026-01-01T00:00:00Z', upstreamIds: null, deletedAt: null, dumpRetentionSeconds: null, openaiResponsesRetentionSeconds: 0 };
const user: User = { id: 1, username: 'test', passwordHash: null, isAdmin: false, upstreamIds: null, createdAt: apiKey.createdAt, deletedAt: null };
const app = new Hono<{ Variables: AuthVars }>();
app.use('*', async (c, next) => { c.set('apiKey', apiKey); c.set('user', user); await next(); });
app.post('/v1beta/models/:modelAction{.+}', geminiGenerateContentHttp);

const reasoning = { type: 'reasoning' as const, id: 'rs_native', summary: [{ type: 'summary_text' as const, text: 'AB' }], encrypted_content: 'native-cipher' };
const message: AnthropicMessagesResult = { container: null, diagnostics: null, stop_details: null, id: 'msg_native', type: 'message', role: 'assistant', model: 'model', stop_reason: 'end_turn', stop_sequence: null, usage: { cache_creation: null, cache_creation_input_tokens: null, cache_read_input_tokens: null, inference_geo: null, output_tokens_details: null, server_tool_use: null, service_tier: null, input_tokens: 2, output_tokens: 3 }, content: [{ type: 'thinking', thinking: 'AB', signature: 'native-signature' }, { type: 'text', text: 'answer', citations: null }] };
const response: OpenAIResponsesResultEx = { id: 'resp_native', object: 'response', model: 'model', status: 'completed', error: null, incomplete_details: null, usage: { input_tokens: 2, output_tokens: 3, total_tokens: 5 }, output: [reasoning, { type: 'message', id: 'msg', role: 'assistant', status: 'completed', content: [{ type: 'output_text', text: 'answer', annotations: [] }] }] };
const cases = (['anthropicMessages', 'openaiResponses'] as const).flatMap(target => [false, true].flatMap(stream => [false, true].map(includeThoughts => ({ target, stream, includeThoughts }))));

test.each(cases)('GenerateContent via $target replays native state without thought text with stream=$stream includeThoughts=$includeThoughts', async ({ target, stream, includeThoughts }) => {
  initRepo(new InMemoryRepo());
  const messages: AnthropicMessagesPayload['messages'][] = [];
  const inputs: CanonicalOpenAIResponsesInputItem[][] = [];
  const provider = stubProvider({
    callAnthropicMessages: async (_model, body) => {
      messages.push(body.messages);
      return {
        ok: true, modelKey: 'key', headers: new Headers({ 'x-native': 'kept' }), events: (async function* () {
          yield eventFrame({ type: 'message_start' as const, message: { ...message, content: [] as [], stop_reason: null, stop_sequence: null } });
          yield eventFrame({ type: 'content_block_start' as const, index: 0, content_block: { type: 'thinking' as const, thinking: '', signature: '' } });
          yield eventFrame({ type: 'content_block_delta' as const, index: 0, delta: { type: 'thinking_delta' as const, thinking: 'AB' } });
          yield eventFrame({ type: 'content_block_delta' as const, index: 0, delta: { type: 'signature_delta' as const, signature: 'native-signature' } });
          yield eventFrame({ type: 'content_block_stop' as const, index: 0 });
          yield eventFrame({ type: 'content_block_start' as const, index: 1, content_block: { type: 'text' as const, text: 'answer', citations: null } });
          yield eventFrame({ type: 'content_block_stop' as const, index: 1 });
          yield eventFrame({ type: 'message_delta' as const, delta: { container: null, stop_details: null, stop_sequence: null, stop_reason: 'end_turn' as const }, usage: { input_tokens: null, cache_creation_input_tokens: null, cache_read_input_tokens: null, output_tokens_details: null, server_tool_use: null, output_tokens: 3 } });
          yield eventFrame({ type: 'message_stop' as const });
        })(),
      };
    },
    callOpenAIResponses: async (_model, body) => {
      inputs.push(body.input);
      return { ok: true, action: 'generate', modelKey: 'key', headers: new Headers({ 'x-native': 'kept' }), events: (async function* () { yield* openaiResponsesResultToEvents(response); })() };
    },
  });
  selected = stubModelCandidate({ model: { id: 'model', endpoints: { [target]: {} } }, provider: { ...stubModelCandidate().provider, instance: provider } });
  const call = async (contents: GeminiGenerateContentContent[]) => {
    const action = stream ? 'streamGenerateContent' : 'generateContent';
    const result = await app.request(`/v1beta/models/model:${action}${stream ? '?alt=sse' : ''}`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ contents, generationConfig: { thinkingConfig: { includeThoughts } } }) });
    expect(result.status, await result.clone().text()).toBe(200);
    expect(result.headers.get('x-native')).toBe('kept');
    return stream ? await collectGeminiGenerateContentProtocolEventsToResult((async function* () {
      for await (const frame of parseSSEStream(result.body!)) yield eventFrame(JSON.parse(frame.data) as GeminiGenerateContentStreamEvent);
    })()) : await result.json() as GeminiGenerateContentResult;
  };
  const first = await call([{ role: 'user', parts: [{ text: 'hello' }] }]);
  const content = first.candidates?.[0].content;
  if (content?.parts === undefined) throw new Error('Expected content');
  expect(content.parts.some(part => part.thought === true)).toBe(includeThoughts);
  expect(Object.keys(content.parts.at(-1)!)).toEqual(['thoughtSignature']);
  await call([{ ...content, parts: content.parts.filter(part => part.thought !== true) }, { role: 'user', parts: [{ text: 'next' }] }]);
  if (target === 'anthropicMessages') expect(messages[1][0].content).toMatchObject([{ type: 'thinking', thinking: 'AB', signature: 'native-signature' }, { type: 'text', text: 'answer' }]);
  else expect(inputs[1][0]).toEqual(reasoning);
  await flushBackground();
});
