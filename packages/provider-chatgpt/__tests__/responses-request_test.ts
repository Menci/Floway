import { expect, test } from 'vitest';

import { CHATGPT_RESPONSES_LITE_CLIENT_METADATA_KEY } from '../src/constants.ts';
import { withChatGPTDefaultInstructions, withoutChatGPTUnsupportedFields } from '../src/responses-payload.ts';
import { prepareChatGPTResponsesRequest } from '../src/responses-request.ts';

const model = { id: 'public-model', providerData: { useResponsesLite: false } };
const prepare = (
  body: Parameters<typeof prepareChatGPTResponsesRequest>[0]['body'],
  headers = new Headers(),
  useResponsesLite = false,
  operation: Parameters<typeof prepareChatGPTResponsesRequest>[1] = 'generate',
) => prepareChatGPTResponsesRequest({
  body,
  model: { ...model, providerData: { useResponsesLite } },
  modelKey: 'wire-model',
  deviceId: 'device-id',
  getHeader: name => headers.get(name),
}, operation);

test('maintains session, window, and request ids while producing a new turn id', () => {
  const headers = new Headers({ 'session-id': 'session' });
  const first = prepare({ input: [] }, headers);
  const second = prepare({ input: [] }, headers);
  expect(first.identity).toMatchObject({
    sessionId: 'session', threadId: 'session', windowId: 'session:0', clientRequestId: 'session', installationId: 'device-id',
  });
  expect(second.identity).toMatchObject({ ...first.identity, turnId: expect.any(String) });
  expect(second.identity.turnId).not.toBe(first.identity.turnId);
});

test('prefers the body turn metadata and only keeps the tool inventory in the body copy', () => {
  const headers = new Headers({
    'session-id': 'upgrade-session',
    'x-codex-window-id': 'thread:0',
    'x-codex-turn-metadata': JSON.stringify({ request_kind: 'turn', window_id: 'thread:0' }),
  });
  const toolInventory = { namespaces: [{ name: 'shell', tools: ['exec'] }] };
  const payload = {
    input: [],
    client_metadata: {
      session_id: 'current-session',
      'x-codex-window-id': 'thread:2',
      'x-codex-turn-metadata': JSON.stringify({ request_kind: 'compaction', compaction: { trigger: 'auto' }, tool_namespaces_info: toolInventory }),
    },
  };
  const prepared = prepare(payload, headers);
  expect(prepared.identity).toMatchObject({ sessionId: 'current-session', windowId: 'thread:2' });
  expect(JSON.parse(prepared.turnMetadataJson.header)).toMatchObject({ request_kind: 'compaction', compaction: { trigger: 'auto' }, window_id: 'thread:2' });
  expect(JSON.parse(prepared.turnMetadataJson.header)).not.toHaveProperty('tool_namespaces_info');
  expect(JSON.parse(prepared.turnMetadataJson.body)).toMatchObject({ tool_namespaces_info: toolInventory });
});

test('injects only an absent cache key', () => {
  const headers = new Headers({ 'session-id': 'thread' });
  expect(prepare({ input: [] }, headers).body.prompt_cache_key).toBe('thread');
  expect(prepare({ input: [], prompt_cache_key: 'caller' }, headers).body.prompt_cache_key).toBe('caller');
  expect(prepare({ input: [], prompt_cache_key: null }, headers).body.prompt_cache_key).toBeNull();
});

test.each([false, true])('uses catalog Lite selection %s for generation and compact', lite => {
  const developer = { type: 'message', role: 'developer', content: 'Keep this developer message.' } as const;
  const tool = { type: 'function', name: 'lookup', parameters: { type: 'object' } } as const;
  const body = {
    input: [developer],
    instructions: 'Base',
    tools: [tool],
    parallel_tool_calls: true,
    reasoning: { effort: 'future-effort' },
    text: { verbosity: 'high' as const },
    service_tier: 'future-tier',
    tool_choice: 'auto' as const,
    client_metadata: { [CHATGPT_RESPONSES_LITE_CLIENT_METADATA_KEY]: String(!lite), caller: 'kept' },
  };
  const generate = prepare(body, undefined, lite);
  const compact = prepare(body, undefined, lite, 'compact');
  for (const prepared of [generate, compact]) {
    expect(prepared.responsesLite).toBe(lite);
    expect(prepared.body).toMatchObject({ model: 'wire-model', service_tier: 'future-tier', text: body.text });
    expect(prepared.body.input).toEqual(expect.arrayContaining([developer]));
    if (lite) {
      expect(prepared.body).not.toHaveProperty('instructions');
      expect(prepared.body).not.toHaveProperty('tools');
      expect(prepared.body).toMatchObject({ parallel_tool_calls: false, reasoning: { effort: 'future-effort', context: 'all_turns' } });
      expect(prepared.body.input).toMatchObject([
        { type: 'additional_tools' },
        { type: 'message', role: 'developer' },
        developer,
      ]);
    } else {
      expect(prepared.body).toMatchObject({ instructions: 'Base', tools: [tool], parallel_tool_calls: true, reasoning: body.reasoning });
    }
  }
  expect(generate.body).toMatchObject({ stream: true, store: false, tool_choice: 'auto', client_metadata: { caller: 'kept' } });
  expect(generate.body.client_metadata).not.toHaveProperty(CHATGPT_RESPONSES_LITE_CLIENT_METADATA_KEY);
  for (const field of ['stream', 'store', 'client_metadata', 'tool_choice']) expect(compact.body).not.toHaveProperty(field);
});

test('defaults blank standard instructions and preserves Lite and caller-supplied instructions', () => {
  const lite = { ...model, providerData: { useResponsesLite: true } };
  for (const payload of [{}, { instructions: null }, { instructions: '' }]) {
    expect(withChatGPTDefaultInstructions(payload, model)).toEqual({ instructions: "You're a helpful assistant." });
    expect(withChatGPTDefaultInstructions(payload, lite)).toBe(payload);
  }
  const custom = { instructions: 'Custom instructions' };
  expect(withChatGPTDefaultInstructions(custom, model)).toBe(custom);
});

test('strips Codex-unsupported public fields while preserving unknown extensions', () => {
  const payload = {
    max_output_tokens: 100, temperature: 0.1, top_p: 0.4, frequency_penalty: 1, presence_penalty: 1,
    user: 'user', metadata: { kept: false }, prompt_cache_retention: '24h', safety_identifier: 'id', stream_options: {},
    input: [], future_extension: 'kept',
  };
  expect(withoutChatGPTUnsupportedFields(payload)).toEqual({ input: [], future_extension: 'kept' });
});
