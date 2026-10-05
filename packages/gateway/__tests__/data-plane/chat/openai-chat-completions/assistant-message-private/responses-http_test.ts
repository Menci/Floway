import { Hono } from 'hono';
import { expect, test, vi } from 'vitest';

import type { AuthVars } from '../../../../../src/middleware/auth.ts';
import { initRepo } from '../../../../../src/repo/index.ts';
import type { ApiKey, User } from '../../../../../src/repo/types.ts';
import { InMemoryRepo } from '../../../../repo/memory.ts';
import { flushBackground } from '../../../../test-utils/background-tracker.ts';
import { eventFrame } from '@floway-dev/protocols/common';
import { collectOpenAIChatCompletionsProtocolEventsToResult, parseOpenAIChatCompletionsStream, type OpenAIChatCompletionsPayload, type OpenAIChatCompletionsResult } from '@floway-dev/protocols/openai-chat-completions';
import type { OpenAIResponsesPayloadEx, OpenAIResponsesResultEx, OpenAIResponsesStreamEventEx } from '@floway-dev/protocols/openai-responses';
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

test.each([false, true])('Responses reasoning survives a complete native upstream HTTP replay with stream=%s', async stream => {
  initRepo(new InMemoryRepo());
  const requests: Array<Omit<OpenAIResponsesPayloadEx, 'model'>> = [];
  const items = [
    { type: 'reasoning' as const, id: 'rs_A', summary: [{ type: 'summary_text' as const, text: 'A' }], encrypted_content: 'cipher-A' },
    { type: 'reasoning' as const, id: 'rs_B', summary: [{ type: 'summary_text' as const, text: 'B' }], encrypted_content: 'cipher-B' },
  ];
  const response = { id: 'resp_1', object: 'response', model: 'model', created_at: 1, status: 'completed', error: null, incomplete_details: null, output: [...items, { type: 'message', id: 'msg_1', role: 'assistant', status: 'completed', content: [{ type: 'output_text', text: 'answer', annotations: [] }] }], usage: { input_tokens: 3, output_tokens: 2, total_tokens: 5 } } as OpenAIResponsesResultEx;
  const provider = stubProvider({
    callOpenAIResponses: async (_model, body) => {
      requests.push(body);
      const events = (async function* () {
        yield eventFrame({ type: 'response.created', response: { ...response, status: 'in_progress', output: [] } } as OpenAIResponsesStreamEventEx);
        for (const [output_index, item] of items.entries()) {
          yield eventFrame({ type: 'response.output_item.added', output_index, item: { ...item, summary: [], encrypted_content: undefined } } as OpenAIResponsesStreamEventEx);
          yield eventFrame({ type: 'response.reasoning_summary_text.delta', output_index, summary_index: 0, item_id: item.id, delta: item.summary[0].text } as OpenAIResponsesStreamEventEx);
          yield eventFrame({ type: 'response.output_item.done', output_index, item } as OpenAIResponsesStreamEventEx);
        }
        yield eventFrame({ type: 'response.output_text.delta', output_index: 2, content_index: 0, item_id: 'msg_1', delta: 'answer' } as OpenAIResponsesStreamEventEx);
        yield eventFrame({ type: 'response.completed', response } as OpenAIResponsesStreamEventEx);
      })();
      return { ok: true, action: 'generate', events, modelKey: 'key', headers: new Headers({ 'x-native': 'kept' }) };
    },
  });
  selected = stubModelCandidate({ model: { id: 'model', endpoints: { openaiResponses: {} } }, provider: { ...stubModelCandidate().provider, instance: provider } });
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
  expect(requests[1].input).toEqual([...response.output, { type: 'message', role: 'user', content: 'continue' }]);
  await flushBackground();
});
