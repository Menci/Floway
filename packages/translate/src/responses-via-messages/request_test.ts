import { test } from 'vitest';

import { translateResponsesToMessages } from './request.ts';
import { assert, assertEquals, assertFalse, assertRejects } from '../test-assert.ts';
import { MESSAGES_FALLBACK_MAX_TOKENS, type MessagesClientTool, type MessagesToolResultBlock, type MessagesUserContentBlock } from '@floway-dev/protocols/messages';

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
      cache_control: { type: 'ephemeral' },
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
      { role: 'user', content: [{ type: 'text', text: 'follow up', cache_control: { type: 'ephemeral' } }] },
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
      // Single (only) function-tool entry receives the breakpoint as the last
      // function tool; applyLastToolCacheBreakpoint walks right-to-left.
      cache_control: { type: 'ephemeral' },
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
        // Last block of the last message — cache_control attached by
        // applyLastMessageCacheBreakpoint.
        cache_control: { type: 'ephemeral' },
      },
    ],
  });
});

test('translateResponsesToMessages keeps plain-text function_call_output as string content', async () => {
  const result = await translateResponsesToMessages({
    model: 'claude-test',
    input: [
      { type: 'function_call', call_id: 'call_1', name: 'tool', arguments: '{}', status: 'completed' },
      { type: 'function_call_output', call_id: 'call_1', output: 'plain text body' },
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

  const userMessage = result.target.messages[1];
  assert(userMessage.role === 'user');
  assert(Array.isArray(userMessage.content));
  const toolResult = userMessage.content[0];
  assert(toolResult.type === 'tool_result');
  assertEquals(toolResult.content, 'plain text body');
});

test('translateResponsesToMessages throws on a stray web_search_call input item (shim owns the reverse path)', async () => {
  // The Responses web-search shim rewrites web_search_call input items into
  // upstream function_call + function_call_output pairs before this
  // translator runs. Reaching the translator with a raw web_search_call
  // means the shim regressed; the translator surfaces a loud error so the
  // bug is caught rather than silently dropping search context.
  await assertRejects(
    () => translateResponsesToMessages({
      model: 'claude-test',
      input: [
        { type: 'message', role: 'user', content: 'hi' },
        {
          type: 'web_search_call',
          id: 'ws_x',
          status: 'completed',
          action: { type: 'search', queries: ['q'] },
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
    }),
    Error,
    'Responses → Messages translator does not accept web_search_call input items',
  );
});

test('translateResponsesToMessages attaches ephemeral cache breakpoints to system, last function tool, and last message block', async () => {
  const result = await translateResponsesToMessages({
    model: 'claude-test',
    input: [
      { type: 'message', role: 'user', content: 'Look up the weather.' },
      { type: 'function_call', call_id: 'tc1', name: 'get_weather', arguments: '{"city":"Tokyo"}', status: 'completed' },
      { type: 'function_call_output', call_id: 'tc1', output: '{"temp":20}' },
    ],
    instructions: 'You are helpful.',
    temperature: null,
    top_p: null,
    max_output_tokens: 256,
    tools: [
      { type: 'function', name: 'get_time', parameters: { type: 'object', properties: {} }, strict: false },
      { type: 'function', name: 'get_weather', parameters: { type: 'object', properties: {} }, strict: false },
    ],
    tool_choice: 'auto',
    metadata: null,
    stream: null,
    store: false,
    parallel_tool_calls: true,
  });

  assertEquals(result.target.system, [{ type: 'text', text: 'You are helpful.', cache_control: { type: 'ephemeral' } }]);

  const tools = result.target.tools as MessagesClientTool[];
  assertEquals(tools[0].cache_control, undefined);
  assertEquals(tools[1].cache_control, { type: 'ephemeral' });

  const lastMessage = result.target.messages[result.target.messages.length - 1];
  const lastBlock = (lastMessage.content as MessagesUserContentBlock[]).at(-1) as MessagesToolResultBlock;
  assertEquals(lastBlock.type, 'tool_result');
  assertEquals(lastBlock.cache_control, { type: 'ephemeral' });
});

test('translateResponsesToMessages extracts flat text.format json_schema into output_config.format and drops OpenAI-only fields', async () => {
  const schema = { type: 'object', properties: { x: { type: 'string' } }, required: ['x'], additionalProperties: false };
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
    text: { format: { type: 'json_schema', name: 'whatever', strict: true, schema } },
  });

  assertEquals(result.target.output_config, { format: { type: 'json_schema', schema } });
});

test('translateResponsesToMessages merges reasoning.effort with structured-output format on a single output_config', async () => {
  const schema = { type: 'object', properties: { ok: { type: 'boolean' } }, required: ['ok'], additionalProperties: false };
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
    reasoning: { effort: 'high', summary: 'detailed' },
    text: { format: { type: 'json_schema', schema } },
  });

  assertEquals(result.target.output_config, { effort: 'high', format: { type: 'json_schema', schema } });
});

test('translateResponsesToMessages drops text.format json_object (no Anthropic equivalent)', async () => {
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
    text: { format: { type: 'json_object' } },
  });

  assertFalse('output_config' in result.target);
});
