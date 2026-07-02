import { test } from 'vitest';

import { translateResponsesToMessages } from './request.ts';
import { assert, assertEquals, assertFalse, assertRejects } from '../test-assert.ts';
import { MESSAGES_FALLBACK_MAX_TOKENS, type MessagesClientTool, type MessagesToolResultBlock, type MessagesUserContentBlock } from '@floway-dev/protocols/messages';

const stubRemoteImageLoader = (result: { mediaType: string | null; data: Uint8Array } | null) => () => Promise.resolve(result);

const minimalPayload = {
  model: 'claude-test',
  input: [{ type: 'message' as const, role: 'user' as const, content: 'hi' }],
  instructions: null,
  temperature: null,
  top_p: null,
  max_output_tokens: 256,
  tools: null,
  tool_choice: 'auto' as const,
  metadata: null,
  stream: null,
  store: false,
  parallel_tool_calls: true,
};

// ── service_tier → speed mapping ──

test('translateResponsesToMessages maps service_tier:fast to speed:fast (no service_tier on target)', async () => {
  const result = await translateResponsesToMessages({ ...minimalPayload, service_tier: 'fast' });

  assertEquals(result.target.speed, 'fast');
  assertFalse('service_tier' in result.target);
});

test('translateResponsesToMessages passes service_tier:priority through as service_tier (no speed override)', async () => {
  const result = await translateResponsesToMessages({ ...minimalPayload, service_tier: 'priority' });

  assertEquals(result.target.service_tier, 'priority');
  assertFalse('speed' in result.target);
});

test('translateResponsesToMessages passes service_tier:auto through as service_tier', async () => {
  const result = await translateResponsesToMessages({ ...minimalPayload, service_tier: 'auto' });

  assertEquals(result.target.service_tier, 'auto');
  assertFalse('speed' in result.target);
});

test('translateResponsesToMessages omits both speed and service_tier when service_tier is absent', async () => {
  const result = await translateResponsesToMessages(minimalPayload);

  assertFalse('speed' in result.target);
  assertFalse('service_tier' in result.target);
});

test('translateResponsesToMessages maps reasoning.effort none to thinking.disabled (summary ignored when reasoning is disabled)', async () => {
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
    reasoning: { effort: 'minimal' },
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

test('translateResponsesToMessages sends the genuine encrypted_content as the upstream signature, with no gateway envelope', async () => {
  const result = await translateResponsesToMessages({
    model: 'claude-test',
    input: [
      {
        type: 'reasoning',
        id: 'rs_42',
        summary: [{ type: 'summary_text', text: 'trace' }],
        encrypted_content: 'opaque-upstream-blob',
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
    signature: 'opaque-upstream-blob',
  });
});

test('translateResponsesToMessages omits the signature for a reasoning with no encrypted_content', async () => {
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

  assertEquals(assistant.content[0], { type: 'thinking', thinking: 'trace' });
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

test('translateResponsesToMessages maps multimodal function_call_output into tool_result image and text blocks', async () => {
  const result = await translateResponsesToMessages({
    model: 'claude-test',
    input: [
      { type: 'function_call', call_id: 'call_1', name: 'screenshot', arguments: '{}', status: 'completed' },
      {
        type: 'function_call_output',
        call_id: 'call_1',
        output: [
          { type: 'input_text', text: 'captured' },
          { type: 'input_image', image_url: 'data:image/png;base64,AQID', detail: 'high' },
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
  });

  const userMessage = result.target.messages[1];
  assert(userMessage.role === 'user');
  assert(Array.isArray(userMessage.content));
  const toolResult = userMessage.content[0];
  assert(toolResult.type === 'tool_result');
  assertEquals(toolResult.content, [
    { type: 'text', text: 'captured' },
    { type: 'image', source: { type: 'base64', media_type: 'image/png', data: 'AQID' } },
  ]);
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
    "Invalid input item type 'web_search_call'",
  );
});

test('translateResponsesToMessages throws on a stray compaction_trigger input item (compact-shim owns the strip)', async () => {
  // The compact-shim is structurally required on non-responses targets and
  // strips compaction_trigger items before reaching this translator.
  // Reaching here with one in input means the shim disengaged; the
  // translator's exhaustive default surfaces the regression.
  await assertRejects(
    () => translateResponsesToMessages({
      model: 'claude-test',
      input: [
        { type: 'message', role: 'user', content: 'hi' },
        { type: 'compaction_trigger' },
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
    'Invalid input item:',
  );
});

test('translateResponsesToMessages throws on a stray compaction input item (compact-shim owns the expansion)', async () => {
  // The compact-shim expands its own shim-encoded compaction items inline
  // before reaching this translator and round-trips foreign compactions
  // back to the upstream as raw items. Either way the translator should
  // never see one.
  await assertRejects(
    () => translateResponsesToMessages({
      model: 'claude-test',
      input: [
        { type: 'message', role: 'user', content: 'hi' },
        { type: 'compaction', id: 'cmp_x', encrypted_content: 'opaque', created_by: 'compaction_session' },
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
    'Invalid input item:',
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

test('translateResponsesToMessages hoists leading role:"system" to top-level system field', async () => {
  const result = await translateResponsesToMessages(
    {
      model: 'claude-test',
      input: [
        { type: 'message', role: 'system', content: 'be terse' },
        { type: 'message', role: 'user', content: 'q1' },
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
    { loadRemoteImage: stubRemoteImageLoader(null) },
  );

  assertEquals(result.target.system, [{ type: 'text', text: 'be terse', cache_control: { type: 'ephemeral' } }]);
  assertEquals(result.target.messages.length, 1);
  assertEquals(result.target.messages[0].role, 'user');
});

test('translateResponsesToMessages keeps non-leading role:"system" inline', async () => {
  const result = await translateResponsesToMessages(
    {
      model: 'claude-test',
      input: [
        { type: 'message', role: 'user', content: 'q1' },
        { type: 'message', role: 'system', content: 'be terse' },
        { type: 'message', role: 'user', content: 'q2' },
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
    { loadRemoteImage: stubRemoteImageLoader(null) },
  );

  assertEquals(result.target.messages.length, 3);
  assertEquals(result.target.messages[0].role, 'user');
  assertEquals(result.target.messages[1], { role: 'system', content: [{ type: 'text', text: 'be terse' }] });
  assertEquals(result.target.messages[2].role, 'user');
  assertFalse('system' in result.target);
});

test('translateResponsesToMessages hoists leading role:"developer" to top-level system field', async () => {
  const result = await translateResponsesToMessages(
    {
      model: 'claude-test',
      input: [
        { type: 'message', role: 'developer', content: 'dev rule' },
        { type: 'message', role: 'user', content: 'hi' },
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
    { loadRemoteImage: stubRemoteImageLoader(null) },
  );

  assertEquals(result.target.messages.length, 1);
  assertEquals(result.target.messages[0].role, 'user');
  assertEquals(result.target.system, [{ type: 'text', text: 'dev rule', cache_control: { type: 'ephemeral' } }]);
});

test('translateResponsesToMessages preserves payload.instructions and leading system as separate blocks; non-leading stays inline', async () => {
  const result = await translateResponsesToMessages(
    {
      model: 'claude-test',
      input: [
        { type: 'message', role: 'system', content: 'leading note' },
        { type: 'message', role: 'user', content: 'hi' },
        { type: 'message', role: 'system', content: 'mid-array note' },
        { type: 'message', role: 'user', content: 'bye' },
      ],
      instructions: 'canonical top-level instructions',
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
    { loadRemoteImage: stubRemoteImageLoader(null) },
  );

  assertEquals(result.target.system, [
    { type: 'text', text: 'canonical top-level instructions' },
    { type: 'text', text: 'leading note', cache_control: { type: 'ephemeral' } },
  ]);
  assertEquals(result.target.messages.length, 3);
  assertEquals(result.target.messages[0].role, 'user');
  assertEquals(result.target.messages[1], { role: 'system', content: [{ type: 'text', text: 'mid-array note' }] });
  assertEquals(result.target.messages[2].role, 'user');
});

test('translateResponsesToMessages throws when a system input message contains an image part', async () => {
  await assertRejects(
    () =>
      translateResponsesToMessages(
        {
          model: 'claude-test',
          input: [
            {
              type: 'message',
              role: 'system',
              content: [
                { type: 'input_text', text: 'You are helpful.' },
                { type: 'input_image', image_url: 'data:image/png;base64,iVBORw0KGgo=', detail: 'auto' },
              ],
            },
            { type: 'message', role: 'user', content: 'hi' },
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
        { loadRemoteImage: stubRemoteImageLoader(null) },
      ),
    Error,
    "Invalid 'input_image' content part in system message",
  );
});

test('translateResponsesToMessages throws when a non-leading developer input message contains an image part', async () => {
  await assertRejects(
    () =>
      translateResponsesToMessages(
        {
          model: 'claude-test',
          input: [
            { type: 'message', role: 'user', content: 'hi' },
            {
              type: 'message',
              role: 'developer',
              content: [
                { type: 'input_image', image_url: 'data:image/png;base64,iVBORw0KGgo=', detail: 'auto' },
              ],
            },
            { type: 'message', role: 'user', content: 'bye' },
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
        { loadRemoteImage: stubRemoteImageLoader(null) },
      ),
    Error,
    "Invalid 'input_image' content part in developer message",
  );
});

// (Native native↔native only — Responses no longer carries thinking-mode
// extension fields; alias overlays land on the Messages IR at the wire
// call via `applyRulesToUpstreamMessages`.)
