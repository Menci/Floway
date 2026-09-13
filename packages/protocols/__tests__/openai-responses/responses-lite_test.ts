import { describe, expect, test } from 'vitest';

import {
  OPENAI_RESPONSES_LITE_HEADER,
  OPENAI_RESPONSES_LITE_WS_METADATA_KEY,
  OpenAIResponsesLiteInputError,
  convertOpenAIResponsesTransport,
  openAIResponsesTransportForRequest,
  replaceOpenAIResponsesAdditionalTools,
  toLiteOpenAIResponsesPayload,
  toStandardOpenAIResponsesPayload,
  type CanonicalOpenAIResponsesPayload,
  type OpenAIResponsesInputAdditionalToolsItem,
} from '../../src/openai-responses/index.ts';

const standard = (): CanonicalOpenAIResponsesPayload => ({
  model: 'gpt-test',
  instructions: 'Be concise.',
  tools: [{ type: 'function', name: 'lookup', description: 'Look up data', parameters: { type: 'object' } }],
  input: [{ type: 'message', role: 'user', content: 'Hello' }],
  parallel_tool_calls: true,
  reasoning: { effort: 'high' },
});

describe('Responses Lite transport', () => {
  test('moves instructions and tools into stable leading input items', () => {
    const first = toLiteOpenAIResponsesPayload({ ...standard(), prompt_cache_key: 'thread-42' });
    expect(first.instructions).toBeUndefined();
    expect(first.tools).toBeUndefined();
    expect(first.parallel_tool_calls).toBe(false);
    expect(first.reasoning).toEqual({ effort: 'high', context: 'all_turns' });
    expect(first.input[0]).toMatchObject({ type: 'additional_tools', role: 'developer' });
    expect(first.input[1]).toMatchObject({
      type: 'message', role: 'developer',
      internal_chat_message_metadata_passthrough: { content_item_kinds: ['model.base_instructions'] },
    });
    expect((first.input[1] as { id?: string }).id).toBe('msg_9904dc4f-4f34-54f2-bf6c-b171457ae84a');
    expect((first.input[0] as { tools?: unknown }).tools).toEqual(standard().tools);
    expect(first).toEqual(toLiteOpenAIResponsesPayload({ ...standard(), prompt_cache_key: 'thread-42' }));
  });

  test('restores a Lite request to the standard wire shape', () => {
    const restored = toStandardOpenAIResponsesPayload(toLiteOpenAIResponsesPayload(standard()));
    expect(restored.instructions).toBe('Be concise.');
    expect(restored.tools).toEqual(standard().tools);
    expect(restored.input).toEqual(standard().input);
  });

  test('rejects conflicting Lite top-level instructions', () => {
    const lite = toLiteOpenAIResponsesPayload(standard());
    expect(() => toStandardOpenAIResponsesPayload({ ...lite, instructions: 'conflict' })).toThrow(/must not declare/);
  });

  test('detects HTTP and per-message WebSocket markers', () => {
    const headers = new Headers({ [OPENAI_RESPONSES_LITE_HEADER]: 'true' });
    expect(openAIResponsesTransportForRequest(standard(), headers)).toBe('lite');
    expect(openAIResponsesTransportForRequest({
      ...standard(), client_metadata: { [OPENAI_RESPONSES_LITE_WS_METADATA_KEY]: 'false' },
    }, headers)).toBe('standard');
  });

  test('strips Lite image detail without changing images or positional metadata', () => {
    const converted = toLiteOpenAIResponsesPayload({
      ...standard(),
      input: [{
        type: 'message', role: 'user',
        content: [
          { type: 'input_text', text: 'Describe both images.' },
          { type: 'input_image', image_url: 'data:image/png;base64,AQID', detail: 'original' },
          { type: 'input_image', image_url: 'https://example.com/image.png', detail: 'high' },
        ],
        internal_chat_message_metadata_passthrough: {
          content_item_kinds: [null, 'custom.inline_image', 'user.image'],
        },
      }],
    });
    const message = converted.input.at(-1);
    expect(message).toMatchObject({
      type: 'message',
      content: [
        { type: 'input_text', text: 'Describe both images.' },
        { type: 'input_image', image_url: 'data:image/png;base64,AQID' },
        { type: 'input_image', image_url: 'https://example.com/image.png' },
      ],
      internal_chat_message_metadata_passthrough: {
        content_item_kinds: [null, 'custom.inline_image', 'user.image'],
      },
    });
    expect(JSON.stringify(message)).not.toContain('detail');
    expect(JSON.stringify(message)).toContain('example.com');
  });

  test('preserves tool capabilities without a transport-owned allowlist', () => {
    const accepted = toLiteOpenAIResponsesPayload({
      ...standard(),
      tools: [
        { type: 'custom', name: 'shell', format: { type: 'grammar' } },
        { type: 'tool_search', execution: 'server' },
        { type: 'web_search' },
        { type: 'namespace', name: 'functions', description: '', tools: [{ type: 'function', name: 'lookup' }] },
      ],
    });
    expect((accepted.input[0] as { tools: unknown[] }).tools).toHaveLength(4);
    expect(toStandardOpenAIResponsesPayload(accepted).tools).toEqual((accepted.input[0] as { tools: unknown[] }).tools);
  });

  test('preserves native Lite prefix identities, chronological controls and open values', () => {
    const lite = toLiteOpenAIResponsesPayload(standard());
    const prefix = lite.input[0];
    if (prefix.type !== 'additional_tools') throw new Error('Expected a Lite tool prefix');
    lite.input[0] = { ...prefix, id: 'at_client_owned' };
    lite.reasoning = { effort: 'ultra', context: 'future_context' };
    lite.input.push({ type: 'additional_tools', role: 'developer', id: 'at_later', tools: [] });
    lite.client_metadata = { [OPENAI_RESPONSES_LITE_WS_METADATA_KEY]: 'true', thread_id: 'client-thread' };
    const normalized = convertOpenAIResponsesTransport(lite, 'lite', 'lite');
    expect(normalized).toEqual({ ...lite, client_metadata: { thread_id: 'client-thread' } });
  });

  test('does not rename forced tools or replayed tool calls', () => {
    const payload: CanonicalOpenAIResponsesPayload = {
      ...standard(),
      tool_choice: { type: 'function', name: 'lookup' },
      input: [{ type: 'function_call', name: 'lookup', call_id: 'call_1', arguments: '{}', status: 'completed' }],
    };
    const lite = toLiteOpenAIResponsesPayload(payload);
    expect((lite.input[0] as { tools: unknown[] }).tools).toEqual(payload.tools);
    expect(lite.tool_choice).toEqual(payload.tool_choice);
    expect(lite.input.at(-1)).toEqual(payload.input[0]);
  });

  test('keeps mixed instruction provenance in the original message', () => {
    const message: CanonicalOpenAIResponsesPayload['input'][number] = {
      type: 'message', role: 'developer',
      content: [{ type: 'input_text', text: 'Base' }, { type: 'input_text', text: 'Update' }],
      internal_chat_message_metadata_passthrough: { content_item_kinds: ['model.base_instructions', 'user.instructions'] },
    };
    const result = toStandardOpenAIResponsesPayload({ model: 'gpt-test', input: [message] });
    expect(result.input).toEqual([message]);
    expect(result.instructions).toBeUndefined();
  });

  test('preserves non-remote image references and case-insensitive data schemes', () => {
    const lite = toLiteOpenAIResponsesPayload({
      model: 'gpt-test',
      input: [{
        type: 'message', role: 'user', content: [
          { type: 'input_image', image_url: 'DATA:image/png;base64,AQID', detail: 'original' },
          { type: 'input_image', file_id: 'file_image', detail: 'high' },
        ],
      }],
    });
    expect(lite.input.at(-1)).toMatchObject({
      content: [
        { type: 'input_image', image_url: 'DATA:image/png;base64,AQID' },
        { type: 'input_image', file_id: 'file_image' },
      ],
    });
    expect(JSON.stringify(lite)).not.toContain('detail');
  });

  test('reports invalid client transport markers as input errors', () => {
    expect(() => openAIResponsesTransportForRequest(standard(), new Headers({ [OPENAI_RESPONSES_LITE_HEADER]: 'invalid' })))
      .toThrow(OpenAIResponsesLiteInputError);
  });

  test('preserves named tool outputs without call ids across native Lite forwarding', () => {
    const payload: CanonicalOpenAIResponsesPayload = {
      model: 'gpt-6-astra',
      input: [{
        type: 'function_call_output', id: 'fco_client', name: 'lookup', namespace: 'research', output: 'Completed.',
        internal_chat_message_metadata_passthrough: { source: 'client', content_item_kinds: ['tool.result'] },
      }],
    };
    expect(convertOpenAIResponsesTransport(payload, 'lite', 'lite')).toEqual(payload);
    expect(convertOpenAIResponsesTransport(payload, 'standard', 'lite').input.at(-1)).toEqual(payload.input[0]);
  });

  test('preserves remote images in both function and custom tool outputs', () => {
    const image = { type: 'input_image' as const, image_url: 'https://example.com/tool.png', detail: 'original' as const };
    const input: CanonicalOpenAIResponsesPayload['input'] = [
      { type: 'function_call_output', call_id: 'call_fn', output: [image] },
      { type: 'custom_tool_call_output', call_id: 'call_custom', output: [image] },
    ];
    const lite = toLiteOpenAIResponsesPayload({ model: 'gpt-test', input });
    expect(lite.input.slice(1)).toEqual(input.map(item => ({
      ...item, output: [{ type: 'input_image', image_url: image.image_url }],
    })));
    expect(convertOpenAIResponsesTransport({ model: 'gpt-test', input }, 'lite', 'lite').input).toEqual(input);
    expect(image.detail).toBe('original');
  });

  test('updates shimmed tool-prefix identity without rebuilding other fields', () => {
    const prefix = {
      type: 'additional_tools', role: 'developer', id: 'at_client',
      tools: [{ type: 'web_search' }],
      internal_chat_message_metadata_passthrough: { trace: 'client' },
    } satisfies OpenAIResponsesInputAdditionalToolsItem & { internal_chat_message_metadata_passthrough: unknown };
    const tools = [{ type: 'function' as const, name: 'search' }];
    expect(replaceOpenAIResponsesAdditionalTools(prefix, [...prefix.tools])).toBe(prefix);
    const rewritten = replaceOpenAIResponsesAdditionalTools(prefix, tools);
    expect(rewritten.id).not.toBe(prefix.id);
    expect(rewritten).toEqual({ ...prefix, id: rewritten.id, tools });
    expect(rewritten).toEqual(replaceOpenAIResponsesAdditionalTools(prefix, tools));
    expect(replaceOpenAIResponsesAdditionalTools({ type: 'additional_tools', role: 'developer', tools: [] }, tools))
      .toEqual({ type: 'additional_tools', role: 'developer', tools });
  });
});
