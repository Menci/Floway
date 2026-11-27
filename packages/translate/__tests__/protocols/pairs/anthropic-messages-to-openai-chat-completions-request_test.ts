import { test } from 'vitest';

import { TranslateInputException } from '../../../src/shared/input-error.ts';
import { buildTargetPayloadFor, pairs } from '../../composition/helpers.ts';
import { createTestSidecarCodec } from '../../round-trip/sidecar-codec.ts';
import type { AnthropicMessagesPayload } from '@floway-dev/protocols/anthropic-messages';
import { assertEquals, assertRejects } from '@floway-dev/test-utils';

const buildWithTestSidecar = (payload: AnthropicMessagesPayload) =>
  buildTargetPayloadFor(pairs.messagesToChat[0], pairs.messagesToChat[1], { ...payload, stream: true }, { sidecarCodec: createTestSidecarCodec() });

test('content-backed document tool output is lifted with its document tags', async () => {
  const result = await buildWithTestSidecar({
    model: 'm', max_tokens: 32, messages: [
      { role: 'assistant', content: [{ type: 'tool_use', id: 'c', name: 'read', input: {} }] },
      {
        role: 'user',
        content: [{
          type: 'tool_result', tool_use_id: 'c', content: [{
            type: 'document',
            source: {
              type: 'content',
              content: [
                { type: 'text', text: 'caption' },
                { type: 'image', source: { type: 'base64', media_type: 'image/png', data: 'AAAA' } },
              ],
            },
          }],
        }],
      },
    ],
  });
  assertEquals(result.messages.at(-2), { role: 'tool', tool_call_id: 'c', content: 'Document output is attached in the following user message.' });
  assertEquals(result.messages.at(-1)?.content, [
    { type: 'text', text: 'Document output from tool call c:' },
    { type: 'text', text: '<document>' },
    { type: 'text', text: 'caption' },
    { type: 'image_url', image_url: { url: 'data:image/png;base64,AAAA' } },
    { type: 'text', text: '</document>' },
  ]);
});

test('buildTargetPayload maps thinking.disabled to reasoning_effort none', async () => {
  const result = await buildWithTestSidecar({
    model: 'gpt-test',
    max_tokens: 256,
    thinking: { type: 'disabled' },
    messages: [{ role: 'user', content: 'hi' }],
  });

  assertEquals(result.reasoning_effort, 'none');
});

test.each([
  { tools: [{ name: 'other', input_schema: { type: 'object' as const } }], name: 'lookup' },
])('buildTargetPayload rejects named tool_choice for an undeclared tool', async ({ tools, name }) => {
  await assertRejects(
    () => buildWithTestSidecar({
      model: 'gpt-test',
      max_tokens: 256,
      messages: [{ role: 'user', content: 'hello' }],
      tools,
      tool_choice: { type: 'tool', name },
    }),
    TranslateInputException,
  );
});

test('buildTargetPayload drops filtered-native tool_choice and rewrites assistant native web-search history as tool-call history', async () => {
  const result = await buildWithTestSidecar({
    model: 'gpt-test',
    max_tokens: 256,
    tool_choice: { type: 'any' },
    tools: [{ type: 'web_search_20260209', name: 'NativeSearch' }],
    messages: [
      {
        role: 'assistant',
        content: [
          {
            caller: { type: 'direct' },
            type: 'server_tool_use',
            id: 'st_1',
            name: 'web_search',
            input: { query: 'React docs' },
          },
          {
            type: 'web_search_tool_result',
            tool_use_id: 'st_1',
            content: [
              {
                type: 'web_search_result',
                url: 'https://react.dev',
                title: 'React',
                encrypted_content: 'opaque-payload',
              },
            ],
          },
        ],
      },
    ],
  });

  assertEquals(result.tools, undefined);
  assertEquals(result.tool_choice, undefined);
  assertEquals(result.messages, [
    {
      role: 'assistant',
      content: null,
      tool_calls: [
        {
          id: 'st_1',
          type: 'function',
          function: {
            name: 'web_search',
            arguments: '{"query":"React docs"}',
          },
        },
      ],
    },
    {
      role: 'tool',
      tool_call_id: 'st_1',
      content: '[{"type":"web_search_result","url":"https://react.dev","title":"React","encrypted_content":"opaque-payload"}]',
    },
  ]);
});

test('buildTargetPayload preserves mixed user/tool_result chronology', async () => {
  const result = await buildWithTestSidecar({
    model: 'gpt-test',
    max_tokens: 256,
    messages: [
      {
        role: 'assistant',
        content: [
          { type: 'tool_use', id: 'toolu_1', name: 'first_lookup', input: {} },
          { type: 'tool_use', id: 'toolu_2', name: 'second_lookup', input: {} },
        ],
      },
      {
        role: 'user',
        content: [
          { type: 'text', text: 'First question.' },
          { type: 'tool_result', tool_use_id: 'toolu_1', content: 'first' },
          { type: 'text', text: 'Follow-up.' },
          { type: 'tool_result', tool_use_id: 'toolu_2', content: 'second' },
        ],
      },
    ],
  });

  assertEquals(result.messages, [
    {
      role: 'assistant', content: null,
      tool_calls: [
        { id: 'toolu_1', type: 'function', function: { name: 'first_lookup', arguments: '{}' } },
        { id: 'toolu_2', type: 'function', function: { name: 'second_lookup', arguments: '{}' } },
      ],
    },
    { role: 'user', content: 'First question.' },
    { role: 'tool', tool_call_id: 'toolu_1', content: 'first' },
    { role: 'user', content: 'Follow-up.' },
    { role: 'tool', tool_call_id: 'toolu_2', content: 'second' },
  ]);
});

test('buildTargetPayload wraps output_config.format json_schema as response_format with nested json_schema and strict', async () => {
  const schema = {
    type: 'object',
    properties: { test: { type: 'string' } },
    required: ['test'],
    additionalProperties: false,
  };
  const result = await buildWithTestSidecar({
    model: 'gpt-test',
    max_tokens: 256,
    messages: [{ role: 'user', content: 'Hi' }],
    output_config: { format: { type: 'json_schema', schema } },
  });

  assertEquals(result.response_format, {
    type: 'json_schema',
    json_schema: { name: 'messages_response', strict: true, schema },
  });
});

test('buildTargetPayload maps speed:fast to service_tier:fast on the outbound OpenAI Chat Completions payload', async () => {
  const result = await buildWithTestSidecar({
    model: 'gpt-test',
    max_tokens: 256,
    speed: 'fast',
    messages: [{ role: 'user', content: 'hi' }],
  });

  assertEquals(result.service_tier, 'priority');
});

test.each([true])('maps disable_parallel_tool_use %s without changing declarations', async disabled => {
  const result = await buildWithTestSidecar({
    model: 'm', max_tokens: 32, messages: [],
    tools: [{ name: 'f', input_schema: { type: 'object', properties: {} } }],
    tool_choice: { type: 'auto', disable_parallel_tool_use: disabled },
  });
  assertEquals(result.parallel_tool_calls, !disabled);
  assertEquals(result.tools?.length, 1);
});
