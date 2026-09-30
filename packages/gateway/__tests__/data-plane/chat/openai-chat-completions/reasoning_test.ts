import { expect, test } from 'vitest';

import { decodeChatCompletionsFrames, encodeChatCompletionsFrames } from '../../../../src/data-plane/chat/openai-chat-completions/reasoning.ts';
import { AffinityCodec } from '../../../../src/data-plane/chat/shared/affinity/index.ts';
import { buildCustomUpstreamRecord, requestAppWithWarmModels, setupAppTest, sseResponse } from '../../../test-utils/app.ts';
import { flushBackground } from '../../../test-utils/background-tracker.ts';
import { decodeReasoningData, eventFrame, type ProtocolFrame } from '@floway-dev/protocols/common';
import { type OpenAIChatCompletionsPayload, type OpenAIChatCompletionsStreamEvent, type ChatCompletionsReasoningFormat } from '@floway-dev/protocols/openai-chat-completions';
import { withMockedFetch } from '@floway-dev/test-utils';

const structured = {
  'openrouter-reasoning-details': [{ type: 'reasoning.summary', summary: 'Summary', id: 'one', index: 0 }, { type: 'reasoning.encrypted', data: 'secret', id: 'one', index: 0, format: 'unknown' }],
  'litellm-thinking-blocks': [{ type: 'thinking', thinking: 'Detailed thought', signature: 'signature', future: { retained: true } }, { type: 'redacted_thinking', data: 'secret' }],
};

for (const data of ['reasoning-opaque', 'openrouter-reasoning-details', 'litellm-thinking-blocks'] as const) {
  for (const stream of [false, true]) {
    test(`native ${data} normalizes responses and replays history (stream=${stream})`, async () => {
      const format: ChatCompletionsReasoningFormat = { text: 'reasoning-content', data };
      const fixture = await setupAppTest({
        copilotUpstream: buildCustomUpstreamRecord({
          chatCompletionsReasoningOverrides: { text: 'reasoning-text', data: 'none' },
          config: { baseUrl: 'https://custom.example.com', authStyle: 'none', ingressHeadersRules: [], endpoints: { openaiChatCompletions: {} }, modelsFetch: { enabled: false }, models: [{ kind: 'chat', upstreamModelId: 'model', endpoints: { openaiChatCompletions: { reasoning: format } } }] },
        }),
      });
      const requests: OpenAIChatCompletionsPayload[] = [];
      const dataField = data === 'reasoning-opaque' ? 'reasoning_opaque' : data === 'openrouter-reasoning-details' ? 'reasoning_details' : 'thinking_blocks';
      const original = data === 'reasoning-opaque' ? 'secret' : structured[data];
      const base = { id: 'chat_test', object: 'chat.completion.chunk', created: 1, model: 'model' };
      await withMockedFetch(async request => {
        expect(new URL(request.url).pathname).toBe('/v1/chat/completions');
        requests.push(await request.json() as OpenAIChatCompletionsPayload);
        return sseResponse([
          { data: { ...base, choices: [{ index: 0, delta: { reasoning_content: 'First ' }, finish_reason: null }] } },
          { data: { ...base, choices: [{ index: 0, delta: { reasoning_content: 'second', [dataField]: original }, finish_reason: null }] } },
          { data: { ...base, choices: [{ index: 0, delta: { content: 'Answer' }, finish_reason: 'stop' }] } },
          { data: '[DONE]' },
        ]);
      }, async () => {
        const headers = { authorization: `Bearer ${fixture.apiKey.key}`, 'content-type': 'application/json' };
        const response = await requestAppWithWarmModels('/v1/chat/completions', { method: 'POST', headers, body: JSON.stringify({ model: 'model', stream, messages: [{ role: 'user', content: 'Hello' }] }) });
        expect(response.status).toBe(200);
        let assistant: Record<string, unknown>;
        if (stream) {
          const events = (await response.text()).split('\n').filter(line => line.startsWith('data: {')).map(line => JSON.parse(line.slice(6)) as OpenAIChatCompletionsStreamEvent);
          const deltas = events.flatMap(event => event.choices.map(choice => choice.delta));
          assistant = { role: 'assistant', content: 'Answer', reasoning: deltas.map(delta => delta.reasoning ?? '').join(''), reasoning_opaque: deltas.findLast(delta => delta.reasoning_opaque !== undefined)?.reasoning_opaque };
        } else assistant = (await response.json() as { choices: { message: Record<string, unknown> }[] }).choices[0].message;
        expect(assistant.reasoning).toBe('First second');
        expect(assistant).not.toHaveProperty('reasoning_content');
        const codec = new AffinityCodec(fixture.apiKey.serverSecret);
        const unwrapped = await codec.unwrap(assistant.reasoning_opaque as string, 'openai-chat-completions.reasoning_opaque');
        expect(unwrapped.kind).toBe('owned');
        if (unwrapped.kind !== 'owned' || unwrapped.value === undefined) throw new Error('Missing original reasoning data');
        expect(data === 'reasoning-opaque' ? unwrapped.value : decodeReasoningData(unwrapped.value)?.value).toEqual(original);
        const replay = await requestAppWithWarmModels('/v1/chat/completions', { method: 'POST', headers, body: JSON.stringify({ model: 'model', messages: [{ role: 'user', content: 'Hello' }, assistant, { role: 'user', content: 'Continue' }] }) });
        expect(replay.status).toBe(200);
        await replay.text();
        await flushBackground();
      });
      expect(requests).toHaveLength(2);
      expect(requests[1].messages[1]).toMatchObject({ reasoning_content: 'First second', [dataField]: original });
      expect(requests[1].messages[1]).not.toHaveProperty('reasoning');
      expect(requests[1].messages[1]).not.toHaveProperty('reasoning_text');
    });
  }
}

test('both reasoning frame boundaries preserve upstream error frames', async () => {
  const error = eventFrame({ error: { message: 'Original upstream error', type: 'api_error' } } as unknown as OpenAIChatCompletionsStreamEvent);
  const source = async function* (): AsyncGenerator<ProtocolFrame<OpenAIChatCompletionsStreamEvent>> { yield error; };
  for (const frames of [decodeChatCompletionsFrames(source(), { text: 'reasoning', data: 'reasoning-opaque' }), encodeChatCompletionsFrames(source())]) {
    const result = [];
    for await (const frame of frames) result.push(frame);
    expect(result).toEqual([error]);
  }
});
