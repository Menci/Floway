import { test } from 'vitest';

import { translateResponsesToMessages } from './request.ts';
import { assertEquals, assertFalse } from '../test-assert.ts';
import { MESSAGES_FALLBACK_MAX_TOKENS } from '@floway-dev/protocols/messages';

const stubRemoteImageLoader = (result: { mediaType: string | null; data: Uint8Array } | null) => () => Promise.resolve(result);

test('translateResponsesToMessages maps reasoning.effort none to thinking.disabled', async () => {
  const result = await translateResponsesToMessages({
    model: 'claude-test',
    input: [{ type: 'message', role: 'user', content: 'hi' }],
    instructions: null,
    temperature: null,
    top_p: null,
    max_output_tokens: 256,
    tools: null,
    tool_choice: 'auto',
    metadata: null,
    stream: null,
    store: false,
    parallel_tool_calls: true,
    reasoning: { effort: 'none', summary: 'detailed' },
  });

  assertEquals(result.target.thinking, { type: 'disabled' });
  assertFalse('output_config' in result.target);
});

test('translateResponsesToMessages maps reasoning.effort directly to output_config.effort', async () => {
  const result = await translateResponsesToMessages({
    model: 'claude-test',
    input: [{ type: 'message', role: 'user', content: 'hi' }],
    instructions: null,
    temperature: null,
    top_p: null,
    max_output_tokens: 256,
    tools: null,
    tool_choice: 'auto',
    metadata: null,
    stream: null,
    store: false,
    parallel_tool_calls: true,
    reasoning: { effort: 'minimal', summary: 'detailed' },
  });

  assertEquals(result.target.output_config, { effort: 'minimal' });
  assertFalse('thinking' in result.target);
});

test('translateResponsesToMessages defaults max_tokens to MESSAGES_FALLBACK_MAX_TOKENS when neither source nor fallbackMaxOutputTokens supplies one', async () => {
  const result = await translateResponsesToMessages({
    model: 'claude-test',
    input: [{ type: 'message', role: 'user', content: 'hi' }],
    instructions: null,
    temperature: null,
    top_p: null,
    max_output_tokens: null,
    tools: null,
    tool_choice: 'auto',
    metadata: null,
    stream: null,
    store: false,
    parallel_tool_calls: true,
  });

  assertEquals(result.target.max_tokens, MESSAGES_FALLBACK_MAX_TOKENS);
});

test('translateResponsesToMessages uses fallbackMaxOutputTokens over the gateway const when the source omitted max_output_tokens', async () => {
  const result = await translateResponsesToMessages(
    {
      model: 'claude-test',
      input: [{ type: 'message', role: 'user', content: 'hi' }],
      instructions: null,
      temperature: null,
      top_p: null,
      max_output_tokens: null,
      tools: null,
      tool_choice: 'auto',
      metadata: null,
      stream: null,
      store: false,
      parallel_tool_calls: true,
    },
    { fallbackMaxOutputTokens: 4096 },
  );

  assertEquals(result.target.max_tokens, 4096);
});

test('translateResponsesToMessages preserves reasoning summaries without Anthropic signatures', async () => {
  const result = await translateResponsesToMessages({
    model: 'claude-test',
    input: [
      {
        type: 'reasoning',
        id: 'rs_42',
        summary: [{ type: 'summary_text', text: 'trace' }],
      },
    ],
    instructions: null,
    temperature: null,
    top_p: null,
    max_output_tokens: 256,
    tools: null,
    tool_choice: 'auto',
    metadata: null,
    stream: null,
    store: false,
    parallel_tool_calls: true,
  });

  const assistant = result.target.messages[0];
  if (assistant.role !== 'assistant' || !Array.isArray(assistant.content)) {
    throw new Error('expected assistant message with content blocks');
  }

  assertEquals(assistant.content[0], {
    type: 'thinking',
    thinking: 'trace',
  });
});

test('translateResponsesToMessages omits generic metadata instead of coercing it to metadata.user_id', async () => {
  const result = await translateResponsesToMessages({
    model: 'claude-test',
    input: [{ type: 'message', role: 'user', content: 'hi' }],
    instructions: null,
    temperature: null,
    top_p: null,
    max_output_tokens: 256,
    tools: null,
    tool_choice: 'auto',
    metadata: { trace_id: 'trace_123' },
    stream: null,
    store: false,
    parallel_tool_calls: true,
  });

  assertFalse('metadata' in result.target);
});

test('translateResponsesToMessages resolves remote input images through the shared loader', async () => {
  const result = await translateResponsesToMessages(
    {
      model: 'claude-test',
      input: [
        {
          type: 'message',
          role: 'user',
          content: [
            {
              type: 'input_image',
              image_url: 'https://example.com/image.png',
              detail: 'auto',
            },
          ],
        },
      ],
      instructions: null,
      temperature: null,
      top_p: null,
      max_output_tokens: 256,
      tools: null,
      tool_choice: 'auto',
      metadata: null,
      stream: null,
      store: false,
      parallel_tool_calls: true,
    },
    {
      loadRemoteImage: stubRemoteImageLoader({
        mediaType: 'image/png',
        data: new Uint8Array([1, 2, 3]),
      }),
    },
  );

  const message = result.target.messages[0];
  if (message.role !== 'user' || !Array.isArray(message.content)) {
    throw new Error('expected user message with content blocks');
  }

  assertEquals(message.content, [
    {
      type: 'image',
      source: {
        type: 'base64',
        media_type: 'image/png',
        data: 'AQID',
      },
    },
  ]);
});

test('translateResponsesToMessages drops reasoning input without readable summary', async () => {
  const result = await translateResponsesToMessages({
    model: 'gpt-test',
    input: [
      { type: 'message', role: 'user', content: 'hi' },
      {
        type: 'reasoning',
        id: 'rs_undef',
        summary: [],
      },
      { type: 'message', role: 'user', content: 'follow up' },
    ],
    instructions: null,
    temperature: null,
    top_p: null,
    max_output_tokens: 256,
    tools: null,
    tool_choice: 'auto',
    metadata: null,
    stream: null,
    store: false,
    parallel_tool_calls: true,
  });

  assertEquals(
    result.target.messages.map(m => ({ role: m.role, content: m.content })),
    [
      { role: 'user', content: 'hi' },
      { role: 'user', content: 'follow up' },
    ],
  );
});

test('translateResponsesToMessages wraps custom tools as single-string function tools and records their names', async () => {
  const result = await translateResponsesToMessages({
    model: 'claude-test',
    input: 'hi',
    instructions: null,
    temperature: null,
    top_p: null,
    max_output_tokens: 256,
    tools: [
      {
        type: 'custom',
        name: 'apply_patch',
        description: 'apply a patch',
        format: { type: 'grammar', syntax: 'lark', definition: 'start: "ok"' },
      },
    ],
    tool_choice: { type: 'custom', name: 'apply_patch' },
    metadata: null,
    stream: null,
    store: false,
    parallel_tool_calls: true,
  });

  assertEquals(result.customToolNames.has('apply_patch'), true);
  assertEquals(result.target.tools, [
    {
      name: 'apply_patch',
      description: 'apply a patch',
      input_schema: {
        type: 'object',
        additionalProperties: false,
        required: ['input'],
        properties: {
          input: {
            type: 'string',
            description: 'Lark grammar: start: "ok"',
          },
        },
      },
    },
  ]);
  assertEquals(result.target.tool_choice, { type: 'tool', name: 'apply_patch' });
});

test('translateResponsesToMessages projects custom_tool_call history into wrapped tool_use shape', async () => {
  const result = await translateResponsesToMessages({
    model: 'claude-test',
    input: [
      { type: 'message', role: 'user', content: 'apply this patch' },
      {
        type: 'custom_tool_call',
        call_id: 'call_1',
        name: 'apply_patch',
        input: '*** Begin Patch\n*** End Patch',
      },
      {
        type: 'custom_tool_call_output',
        call_id: 'call_1',
        output: 'ok',
      },
    ],
    instructions: null,
    temperature: null,
    top_p: null,
    max_output_tokens: 256,
    tools: [{ type: 'custom', name: 'apply_patch' }],
    tool_choice: 'auto',
    metadata: null,
    stream: null,
    store: false,
    parallel_tool_calls: true,
  });

  assertEquals(result.target.messages[1], {
    role: 'assistant',
    content: [
      {
        type: 'tool_use',
        id: 'call_1',
        name: 'apply_patch',
        input: { input: '*** Begin Patch\n*** End Patch' },
      },
    ],
  });
  assertEquals(result.target.messages[2], {
    role: 'user',
    content: [
      {
        type: 'tool_result',
        tool_use_id: 'call_1',
        content: 'ok',
      },
    ],
  });
});
