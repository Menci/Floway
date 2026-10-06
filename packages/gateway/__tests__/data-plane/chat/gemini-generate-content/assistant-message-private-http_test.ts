import { Hono } from 'hono';
import { expect, test, vi } from 'vitest';

import type { AuthVars } from '../../../../src/middleware/auth.ts';
import { initRepo } from '../../../../src/repo/index.ts';
import type { ApiKey, User } from '../../../../src/repo/types.ts';
import { InMemoryRepo } from '../../../repo/memory.ts';
import { flushBackground } from '../../../test-utils/background-tracker.ts';
import { collectChatHistory, chatHistory } from '../shared/assistant-message-private/roundtrip.ts';
import { eventFrame, parseSSEStream } from '@floway-dev/protocols/common';
import { collectGeminiGenerateContentProtocolEventsToResult, type GeminiGenerateContentContent, type GeminiGenerateContentResult, type GeminiGenerateContentStreamEvent } from '@floway-dev/protocols/gemini-generate-content';
import type { OpenAIChatCompletionsPayload, OpenAIChatCompletionsStreamEvent, OpenAIChatCompletionsAssistantMessageEx } from '@floway-dev/protocols/openai-chat-completions';
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

test.each([{ stream: false, includeThoughts: false }, { stream: true, includeThoughts: false }, { stream: false, includeThoughts: true }, { stream: true, includeThoughts: true }])('GenerateContent via Chat replays an independent signature after affinity without thought text: %j', async ({ stream, includeThoughts }) => {
  initRepo(new InMemoryRepo());
  const requests: Array<Omit<OpenAIChatCompletionsPayload, 'model'>> = [];
  const upstream = async function* () {
    const deltas = [{ reasoning_content: 'A' }, { content: 'answer' }, { reasoning_content: 'B' }, { reasoning_opaque: 'native-cipher' }];
    for (const delta of deltas) yield eventFrame({ id: 'chat', object: 'chat.completion.chunk', model: 'model', created: 1, choices: [{ index: 0, delta, finish_reason: null }] } as OpenAIChatCompletionsStreamEvent);
    yield eventFrame({ id: 'chat', object: 'chat.completion.chunk', model: 'model', created: 1, choices: [{ index: 0, delta: {}, finish_reason: 'stop' }], usage: { prompt_tokens: 3, completion_tokens: 2, total_tokens: 5 } } as OpenAIChatCompletionsStreamEvent);
  };
  const expected = chatHistory(await collectChatHistory(upstream()));
  const provider = stubProvider({
    callOpenAIChatCompletions: async (_model, body) => {
      requests.push(body);
      const events = upstream();
      return { ok: true, events, modelKey: 'key', headers: new Headers({ 'x-native': 'kept' }) };
    },
  });
  selected = stubModelCandidate({ model: { id: 'model', endpoints: { openaiChatCompletions: {} } }, provider: { ...stubModelCandidate().provider, instance: provider } });
  const call = async (contents: GeminiGenerateContentContent[]) => {
    const result = await app.request(`/v1beta/models/model:${stream ? 'streamGenerateContent' : 'generateContent'}`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ contents, generationConfig: { thinkingConfig: { includeThoughts } } }) });
    expect(result.status, await result.clone().text()).toBe(200);
    expect(result.headers.get('x-native')).toBe('kept');
    return stream ? await collectGeminiGenerateContentProtocolEventsToResult((async function* () {
      for await (const frame of parseSSEStream(result.body!)) yield eventFrame(JSON.parse(frame.data) as GeminiGenerateContentStreamEvent);
    })()) : await result.json() as GeminiGenerateContentResult;
  };
  const first = await call([{ role: 'user', parts: [{ text: 'hello' }] }]);
  const content = first.candidates![0].content;
  if (content?.parts === undefined) throw new Error('Expected collected content parts');
  expect(content.parts.filter(part => part.thought)).toEqual(includeThoughts ? [{ thought: true, text: 'A' }, { thought: true, text: 'B' }] : []);
  const carrier = content.parts.at(-1)!;
  expect(Object.keys(carrier)).toEqual(['thoughtSignature']);
  expect(typeof carrier.thoughtSignature).toBe('string');
  expect(first.usageMetadata).toMatchObject({ promptTokenCount: 3, candidatesTokenCount: 2, totalTokenCount: 5 });
  await call([{ ...content, parts: content.parts.filter(part => !part.thought) }, { role: 'user', parts: [{ text: 'continue' }] }]);
  expect(chatHistory(requests[1].messages.filter((message): message is OpenAIChatCompletionsAssistantMessageEx => message.role === 'assistant'))).toEqual(expected);
  await flushBackground();
});
