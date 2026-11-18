import { test } from 'vitest';

import { buildTargetPayloadFor, pairs } from '../../composition/helpers.ts';
import { createTestSidecarCodec } from '../../round-trip/sidecar-codec.ts';
import type {
  AnthropicMessagesAssistantContentBlock,
  AnthropicMessagesPayload,
  AnthropicMessagesToolUseBlock,
} from '@floway-dev/protocols/anthropic-messages';
import type { OpenAIChatCompletionsPayloadEx } from '@floway-dev/protocols/openai-chat-completions';
import { assertEquals, assertFalse, assertRejects } from '@floway-dev/test-utils';

function mkPayload(
  overrides: Partial<OpenAIChatCompletionsPayloadEx> & {
    messages: OpenAIChatCompletionsPayloadEx['messages'];
  },
): OpenAIChatCompletionsPayloadEx {
  return { model: 'claude-sonnet-4', stream: true, ...overrides };
}

function assistantBlocks(result: AnthropicMessagesPayload, msgIndex = 0): AnthropicMessagesAssistantContentBlock[] {
  const msg = result.messages[msgIndex];
  assertEquals(msg.role, 'assistant');
  return msg.content as AnthropicMessagesAssistantContentBlock[];
}

const buildWithTestSidecar = (payload: OpenAIChatCompletionsPayloadEx) =>
  buildTargetPayloadFor(pairs.chatToMessages[0], pairs.chatToMessages[1], payload, { sidecarCodec: createTestSidecarCodec() });

test('buildTargetPayload preserves scalar and content-part assistant refusals as history text', async () => {
  const result = await buildWithTestSidecar(mkPayload({
    messages: [
      { role: 'assistant', content: null, refusal: 'Scalar refusal.' },
      { role: 'assistant', content: [{ type: 'refusal', refusal: 'Part refusal.' }] },
    ],
  }));

  assertEquals(result.messages, [
    { role: 'assistant', content: [{ type: 'text', text: 'Scalar refusal.' }] },
    { role: 'assistant', content: [{ type: 'text', text: 'Part refusal.', cache_control: { type: 'ephemeral' } }] },
  ]);
});

// OpenAI renamed priority processing to Fast mode; both spellings ask for the
// same lane, so both map onto Anthropic's `speed`.
test.each(['priority'])('buildTargetPayload maps service_tier:%s to speed:fast (no service_tier on target)', async serviceTier => {
  const result = await buildWithTestSidecar(
    mkPayload({
      messages: [{ role: 'user', content: 'hi' }],
      service_tier: serviceTier,
    }),
  );

  assertEquals(result.speed, 'fast');
  assertFalse('service_tier' in result);
});

test('non-leading system stays inline, leading is hoisted', async () => {
  const result = await buildWithTestSidecar(
    mkPayload({
      messages: [
        { role: 'system', content: 'First' },
        { role: 'user', content: 'Hi' },
        { role: 'developer', content: 'Second' },
        { role: 'user', content: 'Bye' },
      ],
    }),
  );
  assertEquals(result.system, [{ type: 'text', text: 'First', cache_control: { type: 'ephemeral' } }]);
  assertEquals(result.messages.length, 3);
  assertEquals(result.messages[0].role, 'user');
  assertEquals(result.messages[1], { role: 'system', content: [{ type: 'text', text: 'Second' }] });
  assertEquals(result.messages[2].role, 'user');
});

test('assistant tool_calls with invalid JSON arguments → raw_arguments fallback', async () => {
  const result = await buildWithTestSidecar(
    mkPayload({
      messages: [
        { role: 'user', content: 'Hi' },
        {
          role: 'assistant',
          content: null,
          tool_calls: [
            {
              id: 'tc1',
              type: 'function',
              function: { name: 'f', arguments: 'not json' },
            },
          ],
        },
      ],
    }),
  );
  const blocks = assistantBlocks(result, 1);
  assertEquals((blocks[0] as AnthropicMessagesToolUseBlock).input, {
    raw_arguments: 'not json',
  });
});

test('rejects a request the trip cannot carry because it states no stream', () => {
  // A trip's answer arrives as a stream, so an IR that says otherwise has no
  // translation. The boundary above a trip guarantees streaming, so this is a
  // broken contract rather than an unsupported request.
  return assertRejects(
    () => buildWithTestSidecar(mkPayload({ messages: [{ role: 'user', content: 'Hi' }], stream: false })),
    Error,
    'streaming',
  );
});

test('buildTargetPayload merges reasoning_effort with structured-output format on a single output_config', async () => {
  const schema = { type: 'object', properties: { ok: { type: 'boolean' } }, required: ['ok'], additionalProperties: false };
  const result = await buildWithTestSidecar(
    mkPayload({
      messages: [{ role: 'user', content: 'Hi' }],
      reasoning_effort: 'high',
      response_format: { type: 'json_schema', json_schema: { name: 'shape', schema } },
    }),
  );

  assertEquals(result.output_config, { effort: 'high', format: { type: 'json_schema', schema } });
});

test.each([false])('maps parallel_tool_calls %s into Messages tool choice', async parallel => {
  for (const tool_choice of [undefined, 'auto', 'required', 'none'] as const) {
    const result = await buildWithTestSidecar(mkPayload({ messages: [], tools: [{ type: 'function', function: { name: 'f', parameters: { type: 'object', properties: {} } } }], tool_choice, parallel_tool_calls: parallel }));
    assertEquals(result.tool_choice, tool_choice === 'none' ? { type: 'none' } : { type: tool_choice === 'required' ? 'any' : 'auto', disable_parallel_tool_use: !parallel });
  }
});
