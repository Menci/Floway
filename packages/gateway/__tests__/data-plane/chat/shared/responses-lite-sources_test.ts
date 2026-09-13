import { expect, test } from 'vitest';

import { openaiResponsesAttempt } from '../../../../src/data-plane/chat/openai-responses/attempt.ts';
import { initRepo } from '../../../../src/repo/index.ts';
import { InMemoryRepo } from '../../../repo/memory.ts';
import { mockChatGatewayCtx } from '../../../test-utils/gateway-ctx.ts';
import type { AnthropicMessagesPayload, AnthropicMessagesStreamEvent } from '@floway-dev/protocols/anthropic-messages';
import { doneFrame, eventFrame, type ProtocolFrame } from '@floway-dev/protocols/common';
import type { OpenAIChatCompletionsPayload, OpenAIChatCompletionsStreamEvent } from '@floway-dev/protocols/openai-chat-completions';
import { OPENAI_RESPONSES_LITE_HEADER, OPENAI_RESPONSES_LITE_WS_METADATA_KEY, type CanonicalOpenAIResponsesPayload, type OpenAIResponsesStreamEvent } from '@floway-dev/protocols/openai-responses';
import { stubModelCandidate, stubProvider } from '@floway-dev/test-utils';
import { TranslatorInputError } from '@floway-dev/translate';

const parameters = { type: 'object', properties: { city: { type: 'string' } }, required: ['city'] };
const targetToolName = 'research_lookup_2';
const profiles = ['standard', 'lite HTTP', 'lite metadata'] as const;
const targets = ['openaiChatCompletions', 'anthropicMessages'] as const;

const standardPayload = (): CanonicalOpenAIResponsesPayload => ({
  model: 'target-model',
  instructions: 'Use the lookup tool.',
  tools: [
    { type: 'function', name: 'research_lookup', parameters },
    { type: 'namespace', name: 'research', description: 'Research tools', tools: [{ type: 'function', name: 'lookup', parameters }] },
  ],
  tool_choice: { type: 'function', name: 'research.lookup' },
  input: [
    { type: 'message', role: 'user', content: [{ type: 'input_text', text: 'Check Taipei.' }, { type: 'input_image', image_url: 'data:image/png;base64,AQID' }] },
    { type: 'function_call', call_id: 'call_prior', namespace: 'research', name: 'lookup', arguments: '{"city":"Taipei"}', status: 'completed' },
    { type: 'function_call_output', call_id: 'call_prior', output: '{"temperature":25}' },
  ],
});

const sourceRequest = (profile: typeof profiles[number], standard = standardPayload()) => {
  const headers = new Headers(profile === 'lite HTTP' ? { [OPENAI_RESPONSES_LITE_HEADER]: 'true' } : {});
  if (profile === 'standard') return { payload: standard, headers };
  const { tools, instructions, ...rest } = standard;
  const payload: CanonicalOpenAIResponsesPayload = {
    ...rest,
    ...(profile === 'lite metadata' ? { client_metadata: { [OPENAI_RESPONSES_LITE_WS_METADATA_KEY]: 'true' } } : {}),
    input: [
      { type: 'additional_tools', role: 'developer', id: 'at_client', tools: tools ?? [] },
      { type: 'message', role: 'developer', id: 'msg_instructions', content: [{ type: 'input_text', text: instructions ?? '' }], internal_chat_message_metadata_passthrough: { content_item_kinds: ['model.base_instructions'] } },
      ...standard.input,
    ],
  };
  return { payload, headers };
};

const chatEvents = async function* (toolName = targetToolName, args = '{"city":"Kaohsiung"}'): AsyncGenerator<ProtocolFrame<OpenAIChatCompletionsStreamEvent>> {
  const base = { id: 'chat_next', object: 'chat.completion.chunk' as const, created: 1, model: 'target-model' };
  yield eventFrame({ ...base, choices: [{ index: 0, delta: { role: 'assistant', content: 'Checking the next city.' }, finish_reason: null }] });
  yield eventFrame({ ...base, choices: [{ index: 0, delta: { tool_calls: [{ index: 0, id: 'call_next', type: 'function', function: { name: toolName, arguments: args.slice(0, 8) } }] }, finish_reason: null }] });
  yield eventFrame({ ...base, choices: [{ index: 0, delta: { tool_calls: [{ index: 0, function: { arguments: args.slice(8) } }] }, finish_reason: 'tool_calls' }] });
  yield eventFrame({ ...base, choices: [], usage: { prompt_tokens: 10, completion_tokens: 4, total_tokens: 14 } });
  yield doneFrame();
};

const anthropicEvents = async function* (toolName = targetToolName, args = '{"city":"Kaohsiung"}'): AsyncGenerator<ProtocolFrame<AnthropicMessagesStreamEvent>> {
  yield eventFrame({ type: 'message_start', message: { id: 'msg_next', type: 'message', role: 'assistant', model: 'target-model', content: [], stop_reason: null, stop_sequence: null, usage: { input_tokens: 10, output_tokens: 0 } } });
  yield eventFrame({ type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } });
  yield eventFrame({ type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'Checking the next city.' } });
  yield eventFrame({ type: 'content_block_stop', index: 0 });
  yield eventFrame({ type: 'content_block_start', index: 1, content_block: { type: 'tool_use', id: 'call_next', name: toolName, input: {} } });
  yield eventFrame({ type: 'content_block_delta', index: 1, delta: { type: 'input_json_delta', partial_json: args.slice(0, 8) } });
  yield eventFrame({ type: 'content_block_delta', index: 1, delta: { type: 'input_json_delta', partial_json: args.slice(8) } });
  yield eventFrame({ type: 'content_block_stop', index: 1 });
  yield eventFrame({ type: 'message_delta', delta: { stop_reason: 'tool_use' }, usage: { output_tokens: 4 } });
  yield eventFrame({ type: 'message_stop' });
};

for (const target of targets) {
  for (const profile of profiles) {
    test(`${profile} Responses preserves namespaced tool turns through ${target}`, async () => {
      initRepo(new InMemoryRepo());
      let chatBody: Omit<OpenAIChatCompletionsPayload, 'model'> | undefined;
      let anthropicBody: Omit<AnthropicMessagesPayload, 'model'> | undefined;
      let observedHeaders: Headers | undefined;
      let calls = 0;
      const provider = stubProvider({
        callOpenAIChatCompletions: (_model, body, _signal, options) => {
          expect(target).toBe('openaiChatCompletions');
          calls++;
          chatBody = body;
          observedHeaders = options.headers;
          return Promise.resolve({ ok: true, modelKey: 'target-model', events: chatEvents() });
        },
        callAnthropicMessages: (_model, body, _signal, options) => {
          expect(target).toBe('anthropicMessages');
          calls++;
          anthropicBody = body;
          observedHeaders = options.headers;
          return Promise.resolve({ ok: true, modelKey: 'target-model', events: anthropicEvents() });
        },
      });
      const candidate = stubModelCandidate({ model: { endpoints: { [target]: {} } } });
      candidate.provider.instance = provider;
      candidate.provider.inboundHeaderAllowlist = [OPENAI_RESPONSES_LITE_HEADER];
      const source = sourceRequest(profile);
      const originalPayload = structuredClone(source.payload);
      const result = await openaiResponsesAttempt.generate({ ...source, candidate, ctx: mockChatGatewayCtx({ wantsStream: true }) });
      expect(result.type).toBe('events');
      if (result.type !== 'events') throw new Error('Expected translated stream');
      const events: OpenAIResponsesStreamEvent[] = [];
      for await (const frame of result.events) if (frame.type === 'event') events.push(frame.event);

      expect(calls).toBe(1);
      expect(observedHeaders?.get(OPENAI_RESPONSES_LITE_HEADER)).toBeNull();
      const serializedBody = JSON.stringify(chatBody ?? anthropicBody);
      expect(serializedBody).not.toContain('client_metadata');
      expect(serializedBody).not.toContain(OPENAI_RESPONSES_LITE_WS_METADATA_KEY);
      expect(serializedBody).not.toContain('additional_tools');
      expect(serializedBody).toContain('Check Taipei.');
      expect(serializedBody).toContain('AQID');
      if (target === 'openaiChatCompletions') {
        expect(chatBody?.tools).toMatchObject([{ type: 'function', function: { name: 'research_lookup' } }, { type: 'function', function: { name: targetToolName, parameters } }]);
        expect(chatBody?.tool_choice).toEqual({ type: 'function', function: { name: targetToolName } });
        expect(chatBody?.messages).toEqual(expect.arrayContaining([
          { role: 'system', content: 'Use the lookup tool.' },
          { role: 'assistant', content: null, tool_calls: [{ type: 'function', id: 'call_prior', function: { name: targetToolName, arguments: '{"city":"Taipei"}' } }] },
          { role: 'tool', tool_call_id: 'call_prior', content: '{"temperature":25}' },
        ]));
      } else {
        expect(anthropicBody?.tools).toMatchObject([{ name: 'research_lookup' }, { name: targetToolName, input_schema: parameters }]);
        expect(anthropicBody?.tool_choice).toEqual({ type: 'tool', name: targetToolName });
        expect(anthropicBody?.system).toEqual(expect.arrayContaining([expect.objectContaining({ type: 'text', text: 'Use the lookup tool.' })]));
        expect(anthropicBody?.messages).toEqual(expect.arrayContaining([
          expect.objectContaining({ role: 'assistant', content: expect.arrayContaining([{ type: 'tool_use', id: 'call_prior', name: targetToolName, input: { city: 'Taipei' } }]) }),
          expect.objectContaining({ role: 'user', content: expect.arrayContaining([expect.objectContaining({ type: 'tool_result', tool_use_id: 'call_prior', content: '{"temperature":25}' })]) }),
        ]));
      }
      for (const type of ['response.output_item.added', 'response.output_item.done'] as const) {
        expect(events).toContainEqual(expect.objectContaining({ type, item: expect.objectContaining({ type: 'function_call', call_id: 'call_next', namespace: 'research', name: 'lookup' }) }));
      }
      expect(events).toContainEqual(expect.objectContaining({ type: 'response.function_call_arguments.delta', delta: '{"city":' }));
      const completed = events.find(event => event.type === 'response.completed');
      expect(completed?.response.output).toEqual(expect.arrayContaining([
        expect.objectContaining({ type: 'message', content: [expect.objectContaining({ type: 'output_text', text: 'Checking the next city.' })] }),
        expect.objectContaining({ type: 'function_call', call_id: 'call_next', namespace: 'research', name: 'lookup', arguments: '{"city":"Kaohsiung"}' }),
      ]));
      expect(completed?.response.usage).toMatchObject({ input_tokens: 10, output_tokens: 4, total_tokens: 14 });
      expect(source.payload).toEqual(originalPayload);
      expect(source.headers.get(OPENAI_RESPONSES_LITE_HEADER)).toBe(profile === 'lite HTTP' ? 'true' : null);
    });

    test(`${profile} Responses restores namespaced custom tool calls through ${target}`, async () => {
      initRepo(new InMemoryRepo());
      const alias = 'functions_apply_patch_2';
      const input = 'PATCH new\n';
      let chatBody: Omit<OpenAIChatCompletionsPayload, 'model'> | undefined;
      let anthropicBody: Omit<AnthropicMessagesPayload, 'model'> | undefined;
      let calls = 0;
      const provider = stubProvider({
        callOpenAIChatCompletions: (_model, body) => {
          expect(target).toBe('openaiChatCompletions');
          calls++;
          chatBody = body;
          return Promise.resolve({ ok: true, modelKey: 'target-model', events: chatEvents(alias, JSON.stringify({ input })) });
        },
        callAnthropicMessages: (_model, body) => {
          expect(target).toBe('anthropicMessages');
          calls++;
          anthropicBody = body;
          return Promise.resolve({ ok: true, modelKey: 'target-model', events: anthropicEvents(alias, JSON.stringify({ input })) });
        },
      });
      const candidate = stubModelCandidate({ model: { endpoints: { [target]: {} } } });
      candidate.provider.instance = provider;
      const standard: CanonicalOpenAIResponsesPayload = {
        model: 'target-model', instructions: 'Apply the patch.',
        tools: [
          { type: 'function', name: 'functions_apply_patch' },
          { type: 'namespace', name: 'functions', description: 'Patch tools', tools: [{ type: 'custom', name: 'apply_patch', format: { type: 'grammar', syntax: 'lark', definition: 'start: "PATCH"' } }] },
        ],
        tool_choice: { type: 'custom', name: 'functions.apply_patch' },
        input: [
          { type: 'message', role: 'user', content: 'Update the patch.' },
          { type: 'custom_tool_call', namespace: 'functions', name: 'apply_patch', call_id: 'patch_prior', input: 'PATCH old\n' },
          { type: 'custom_tool_call_output', call_id: 'patch_prior', output: 'Patched.' },
        ],
      };
      const result = await openaiResponsesAttempt.generate({ ...sourceRequest(profile, standard), candidate, ctx: mockChatGatewayCtx({ wantsStream: true }) });
      expect(result.type).toBe('events');
      if (result.type !== 'events') throw new Error('Expected translated custom tool stream');
      const events: OpenAIResponsesStreamEvent[] = [];
      for await (const frame of result.events) if (frame.type === 'event') events.push(frame.event);
      expect(calls).toBe(1);
      if (target === 'openaiChatCompletions') {
        expect(chatBody?.tools?.[1]).toMatchObject({ type: 'function', function: { name: alias, parameters: { properties: { input: { type: 'string', description: 'Lark grammar: start: "PATCH"' } } } } });
        expect(chatBody?.tool_choice).toEqual({ type: 'function', function: { name: alias } });
        expect(chatBody?.messages).toEqual(expect.arrayContaining([
          expect.objectContaining({ role: 'assistant', tool_calls: [{ type: 'function', id: 'patch_prior', function: { name: alias, arguments: JSON.stringify({ input: 'PATCH old\n' }) } }] }),
          { role: 'tool', tool_call_id: 'patch_prior', content: 'Patched.' },
        ]));
      } else {
        expect(anthropicBody?.tools?.[1]).toMatchObject({ name: alias, input_schema: { properties: { input: { type: 'string', description: 'Lark grammar: start: "PATCH"' } } } });
        expect(anthropicBody?.tool_choice).toEqual({ type: 'tool', name: alias });
        expect(anthropicBody?.messages).toEqual(expect.arrayContaining([
          expect.objectContaining({ role: 'assistant', content: [{ type: 'tool_use', id: 'patch_prior', name: alias, input: { input: 'PATCH old\n' } }] }),
          expect.objectContaining({ role: 'user', content: expect.arrayContaining([expect.objectContaining({ type: 'tool_result', tool_use_id: 'patch_prior', content: 'Patched.' })]) }),
        ]));
      }
      expect(events).toContainEqual(expect.objectContaining({ type: 'response.output_item.added', item: expect.objectContaining({ type: 'custom_tool_call', namespace: 'functions', name: 'apply_patch', call_id: 'call_next', input: '' }) }));
      expect(events).toContainEqual(expect.objectContaining({ type: 'response.output_item.done', item: expect.objectContaining({ type: 'custom_tool_call', namespace: 'functions', name: 'apply_patch', call_id: 'call_next', input }) }));
      expect(events.find(event => event.type === 'response.completed')?.response.output).toEqual(expect.arrayContaining([expect.objectContaining({ type: 'custom_tool_call', namespace: 'functions', name: 'apply_patch', call_id: 'call_next', input })]));
    });

    for (const unsupported of ['async declaration', 'async custom declaration', 'async history', 'configuration_update', 'named output without call_id'] as const) {
      test(`${profile} Responses rejects ${unsupported} before calling ${target}`, async () => {
        initRepo(new InMemoryRepo());
        let calls = 0;
        const provider = stubProvider({
          callOpenAIChatCompletions: () => { calls++; throw new Error('Unsupported payload reached provider'); },
          callAnthropicMessages: () => { calls++; throw new Error('Unsupported payload reached provider'); },
        });
        const candidate = stubModelCandidate({ model: { endpoints: { [target]: {} } } });
        candidate.provider.instance = provider;
        const standard = standardPayload();
        if (unsupported === 'async declaration') standard.tools = [{ type: 'namespace', name: 'research', description: 'Research tools', tools: [{ type: 'function', name: 'lookup', parameters, async: true }] }];
        if (unsupported === 'async custom declaration') standard.tools = [{ type: 'namespace', name: 'research', description: 'Research tools', tools: [{ type: 'custom', name: 'lookup', async: true }] }];
        if (unsupported === 'async history') standard.input.push({ type: 'function_call', call_id: 'call_pending', namespace: 'research', name: 'lookup', arguments: '{}', async: true });
        if (unsupported === 'configuration_update') standard.input.push({ type: 'configuration_update', reasoning: { effort: 'ultra' } });
        if (unsupported === 'named output without call_id') standard.input.push({ type: 'function_call_output', namespace: 'research', name: 'lookup', output: 'Finished.', internal_chat_message_metadata_passthrough: { source: 'client' } });
        const promise = openaiResponsesAttempt.generate({ ...sourceRequest(profile, standard), candidate, ctx: mockChatGatewayCtx({ wantsStream: true }) });
        await expect(promise).rejects.toBeInstanceOf(TranslatorInputError);
        await expect(promise).rejects.toThrow(unsupported === 'configuration_update' ? 'configuration_update' : unsupported === 'named output without call_id' ? 'without call_id' : /asynchronous/i);
        expect(calls).toBe(0);
      });
    }
  }
}
