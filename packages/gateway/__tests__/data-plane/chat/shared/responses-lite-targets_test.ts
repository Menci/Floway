import { expect, test } from 'vitest';

import { anthropicMessagesAttempt } from '../../../../src/data-plane/chat/anthropic-messages/attempt.ts';
import { geminiGenerateContentAttempt } from '../../../../src/data-plane/chat/gemini-generate-content/attempt.ts';
import { openaiChatCompletionsAttempt } from '../../../../src/data-plane/chat/openai-chat-completions/attempt.ts';
import type { ChatGatewayCtx } from '../../../../src/data-plane/chat/shared/gateway-ctx.ts';
import { initRepo } from '../../../../src/repo/index.ts';
import { InMemoryRepo } from '../../../repo/memory.ts';
import { mockChatGatewayCtx } from '../../../test-utils/gateway-ctx.ts';
import type { ProtocolFrame } from '@floway-dev/protocols/common';
import {
  OPENAI_RESPONSES_LITE_HEADER,
  OPENAI_RESPONSES_LITE_WS_METADATA_KEY,
  openaiResponsesResultToEvents,
  type CanonicalOpenAIResponsesPayload,
  type OpenAIResponsesResult,
} from '@floway-dev/protocols/openai-responses';
import type { ExecuteResult, ModelCandidate, ProviderOpenAIResponsesResult } from '@floway-dev/provider';
import { stubModelCandidate, stubProvider } from '@floway-dev/test-utils';

const parameters = { type: 'object', properties: { city: { type: 'string' } }, required: ['city'] };
const sourceMetadata = { client_metadata: { [OPENAI_RESPONSES_LITE_WS_METADATA_KEY]: 'true' } };

interface InvocationArgs {
  ctx: ChatGatewayCtx;
  candidate: ModelCandidate;
  headers: Headers;
}

const sources: Array<{
  name: string;
  invoke: (args: InvocationArgs) => Promise<ExecuteResult<ProtocolFrame<unknown>>>;
}> = [
  {
    name: 'OpenAI Chat Completions',
    invoke: args => openaiChatCompletionsAttempt.generate({
      ...args,
      payload: {
        ...sourceMetadata,
        model: 'gpt-6-astra',
        tools: [{ type: 'function', function: { name: 'lookup', parameters } }],
        tool_choice: { type: 'function', function: { name: 'lookup' } },
        reasoning_effort: 'high',
        messages: [
          { role: 'system', content: 'Use the lookup tool.' },
          { role: 'user', content: [{ type: 'text', text: 'Check Taipei.' }, { type: 'image_url', image_url: { url: 'data:image/png;base64,AQID', detail: 'high' } }] },
          { role: 'assistant', content: null, tool_calls: [{ type: 'function', id: 'call_prior', function: { name: 'lookup', arguments: '{"city":"Taipei"}' } }] },
          { role: 'tool', tool_call_id: 'call_prior', content: '{"temperature":25}' },
        ],
      },
    }),
  },
  {
    name: 'Anthropic Messages',
    invoke: args => anthropicMessagesAttempt.generate({
      ...args,
      anthropicBeta: [],
      payload: {
        ...sourceMetadata,
        model: 'gpt-6-astra', max_tokens: 256, system: 'Use the lookup tool.',
        tools: [{ name: 'lookup', input_schema: parameters }],
        tool_choice: { type: 'tool', name: 'lookup' },
        output_config: { effort: 'high' },
        messages: [
          { role: 'user', content: [{ type: 'text', text: 'Check Taipei.' }, { type: 'image', source: { type: 'base64', media_type: 'image/png', data: 'AQID' } }] },
          { role: 'assistant', content: [{ type: 'tool_use', id: 'call_prior', name: 'lookup', input: { city: 'Taipei' } }] },
          { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'call_prior', content: '{"temperature":25}' }] },
        ],
      },
    }),
  },
  {
    name: 'Gemini generateContent',
    invoke: args => geminiGenerateContentAttempt.generate({
      ...args,
      payload: {
        ...sourceMetadata,
        systemInstruction: { parts: [{ text: 'Use the lookup tool.' }] },
        tools: [{ functionDeclarations: [{ name: 'lookup', parameters }] }],
        toolConfig: { functionCallingConfig: { mode: 'ANY', allowedFunctionNames: ['lookup'] } },
        generationConfig: { thinkingConfig: { thinkingLevel: 'high' } },
        contents: [
          { role: 'user', parts: [{ text: 'Check Taipei.' }, { inlineData: { mimeType: 'image/png', data: 'AQID' } }] },
          { role: 'model', parts: [{ functionCall: { id: 'call_prior', name: 'lookup', args: { city: 'Taipei' } } }] },
          { role: 'user', parts: [{ functionResponse: { id: 'call_prior', name: 'lookup', response: { temperature: 25 } } }] },
        ],
      },
    }),
  },
];

const response: OpenAIResponsesResult = {
  id: 'resp_lite', object: 'response', model: 'gpt-6-astra', status: 'completed',
  error: null, incomplete_details: null,
  output: [
    { type: 'message', id: 'msg_lite', role: 'assistant', status: 'completed', content: [{ type: 'output_text', text: 'Checking the next city.', annotations: [] }] },
    { type: 'function_call', id: 'fc_next', call_id: 'call_next', name: 'lookup', arguments: '{"city":"Kaohsiung"}', status: 'completed' },
  ],
  usage: { input_tokens: 10, output_tokens: 4, total_tokens: 14 },
};

for (const source of sources) {
  for (const { transport, sourceMarker } of ['standard', 'lite'].flatMap(transport => [undefined, 'true'].map(sourceMarker => ({ transport: transport as 'standard' | 'lite', sourceMarker })))) {
    test(`${source.name} routes its tool loop through ${transport} Responses with source marker ${sourceMarker ?? 'absent'}`, async () => {
      initRepo(new InMemoryRepo());
      let observedBody: Omit<CanonicalOpenAIResponsesPayload, 'model'> | undefined;
      let observedHeaders: Headers | undefined;
      let calls = 0;
      const provider = stubProvider({
        callOpenAIResponses: (_model, body, action, _signal, options): Promise<ProviderOpenAIResponsesResult> => {
          calls++;
          expect(action).toBe('generate');
          observedBody = body;
          observedHeaders = options?.headers;
          return Promise.resolve({
            action: 'generate', ok: true, modelKey: 'gpt-6-astra',
            events: (async function* () { yield* openaiResponsesResultToEvents(response); })(),
          });
        },
      });
      const candidate = stubModelCandidate({ model: { id: 'gpt-6-astra', endpoints: { openaiResponses: { transport } } } });
      candidate.provider.instance = provider;
      const headers = new Headers(sourceMarker === undefined ? {} : { [OPENAI_RESPONSES_LITE_HEADER]: sourceMarker });
      const result = await source.invoke({ ctx: mockChatGatewayCtx({ wantsStream: true }), candidate, headers });
      expect(result.type).toBe('events');
      if (result.type !== 'events') throw new Error('Expected translated stream');
      const events: unknown[] = [];
      for await (const frame of result.events) if (frame.type === 'event') events.push(frame.event);

      expect(calls).toBe(1);
      expect(observedHeaders?.get(OPENAI_RESPONSES_LITE_HEADER)).toBe(transport === 'lite' ? 'true' : null);
      expect(observedBody?.client_metadata).toBeUndefined();
      expect(observedBody?.tool_choice).toEqual({ type: 'function', name: 'lookup' });
      if (transport === 'lite') {
        expect(observedBody?.tools).toBeUndefined();
        expect(observedBody?.instructions).toBeUndefined();
        expect(observedBody?.parallel_tool_calls).toBe(false);
        expect(observedBody?.reasoning).toMatchObject({ effort: 'high', context: 'all_turns' });
        expect(observedBody?.input[0]).toMatchObject({ type: 'additional_tools', role: 'developer', tools: [{ type: 'function', name: 'lookup', parameters }] });
      } else {
        expect(observedBody?.tools).toMatchObject([{ type: 'function', name: 'lookup', parameters }]);
        expect(observedBody?.instructions).toBe('Use the lookup tool.');
        expect(observedBody?.reasoning).toEqual({ effort: 'high' });
        expect(observedBody?.input.some(item => item.type === 'additional_tools')).toBe(false);
      }
      expect(observedBody?.input).toEqual(expect.arrayContaining([
        expect.objectContaining({ type: 'function_call', call_id: 'call_prior', name: 'lookup', arguments: '{"city":"Taipei"}' }),
        expect.objectContaining({ type: 'function_call_output', call_id: 'call_prior', output: '{"temperature":25}' }),
      ]));
      const serializedInput = JSON.stringify(observedBody?.input);
      if (transport === 'lite') expect(serializedInput).toContain('Use the lookup tool.');
      expect(serializedInput).toContain('data:image/png;base64,AQID');
      if (transport === 'lite') expect(serializedInput).not.toContain('"detail"');
      const serializedEvents = JSON.stringify(events);
      expect(serializedEvents).toContain('Checking the next city.');
      expect(serializedEvents).toContain('call_next');
      expect(serializedEvents).toContain('lookup');
      expect(serializedEvents).toContain('Kaohsiung');
      expect(headers.get(OPENAI_RESPONSES_LITE_HEADER)).toBe(sourceMarker ?? null);
    });
  }
}
