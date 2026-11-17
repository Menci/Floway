import { test } from 'vitest';

import { buildTargetPayloadFor, pairs } from '../../composition/helpers.ts';
import { createTestSidecarCodec } from '../../round-trip/sidecar-codec.ts';
import { ANTHROPIC_MESSAGES_FALLBACK_MAX_TOKENS, type AnthropicMessagesClientTool, type AnthropicMessagesToolResultBlock, type AnthropicMessagesUserContentBlock } from '@floway-dev/protocols/anthropic-messages';
import type { OpenAIResponsesInputMultiAgentCallOutputItem, OpenAIResponsesTool, OpenAIResponsesRequestPayloadEx } from '@floway-dev/protocols/openai-responses';
import { assert, assertEquals, assertFalse, assertRejects } from '@floway-dev/test-utils';

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

const testBuildOptions: { fallbackMaxOutputTokens?: number } = {
  fallbackMaxOutputTokens: undefined,
};

const buildWithTestSidecar = async (
  payload: OpenAIResponsesRequestPayloadEx,
  options: Partial<typeof testBuildOptions> = {},
) => {
  const streamed = { ...payload, stream: true };
  const built = await buildTargetPayloadFor(pairs.responsesToMessages[0], pairs.responsesToMessages[1], streamed, { sidecarCodec: createTestSidecarCodec(), ...testBuildOptions, ...options });
  return { target: built };
};

test('buildTargetPayload preserves unsafe JSON number tokens in function history', async () => {
  const result = await buildWithTestSidecar({
    ...minimalPayload,
    input: [{ type: 'function_call', call_id: 'call_1', name: 'tool', arguments: '{"n":1e400}', status: 'completed' }],
  });
  const message = result.target.messages[0];
  if (message.role !== 'assistant' || !Array.isArray(message.content)) throw new Error('expected assistant tool history');
  const tool = message.content[0];
  if (tool.type !== 'tool_use') throw new Error('expected tool_use');
  assertEquals(JSON.stringify(tool.input), '{"n":1e400}');
});

test('top-level instructions stay separate from leading historical role messages', async () => {
  const result = await buildWithTestSidecar({
    ...minimalPayload,
    instructions: 'base',
    input: [
      { type: 'message', role: 'system', content: 'rule' },
      { type: 'message', role: 'developer', content: 'dev' },
      { type: 'message', role: 'user', content: 'question' },
    ],
  });
  assertEquals(result.target.system, [{ type: 'text', text: 'base', cache_control: { type: 'ephemeral' } }]);
  assertEquals(result.target.messages, [
    { role: 'system', content: [{ type: 'text', text: 'rule' }] },
    { role: 'system', content: [{ type: 'text', text: 'dev' }] },
    { role: 'user', content: [{ type: 'text', text: 'question', cache_control: { type: 'ephemeral' } }] },
  ]);
});

test('buildTargetPayload accepts an implicit message discriminator', async () => {
  const result = await buildWithTestSidecar({
    ...minimalPayload,
    input: [{ role: 'user', content: 'hello' }],
  });

  assertEquals(result.target.messages, [
    {
      role: 'user',
      content: [{ type: 'text', text: 'hello', cache_control: { type: 'ephemeral' } }],
    },
  ]);
});

test('buildTargetPayload rejects an agent_message that no interceptor lowered', async () => {
  await assertRejects(
    () => buildWithTestSidecar({
      ...minimalPayload,
      input: [{
        type: 'agent_message',
        author: '/root/reviewer',
        recipient: '/root',
        content: [{ type: 'input_text', text: 'done' }],
      }],
    }),
    Error,
    'agent_message',
  );
});

test('an empty namespace description does not prefix a child description', async () => {
  const result = await buildWithTestSidecar({
    ...minimalPayload,
    tools: [{ type: 'namespace', name: 'group', description: '', tools: [{ type: 'function', name: 'f', description: 'meaning', parameters: { type: 'object' } }] }],
  });
  const tool = result.target.tools?.[0];
  assertEquals(tool !== undefined && 'description' in tool ? tool.description : undefined, 'meaning');
});

test.each([
  { name: 'program', input: [{ type: 'program', id: 'prog_1', call_id: 'call_prog_1', code: 'return 1', fingerprint: 'opaque' }] },
  { name: 'program_output', input: [{ type: 'program_output', id: 'prog_out_1', call_id: 'call_prog_1', result: '1', status: 'completed' }] },
  { name: 'multi_agent_call', input: [{ type: 'multi_agent_call', action: 'spawn_agent', arguments: '{}', call_id: 'call_1' }] },
  { name: 'multi_agent_call_output', input: [{ type: 'multi_agent_call_output', action: 'spawn_agent', call_id: 'call_1', output: [] as OpenAIResponsesInputMultiAgentCallOutputItem['output'] }] },
  { name: 'context_compaction', input: [{ type: 'context_compaction', encrypted_content: 'opaque' }] },
  { name: 'item_reference', input: [{ type: 'item_reference', id: 'msg_1' }] },
] as const)('buildTargetPayload rejects OpenAI-Responses-only $name input', async ({ name, input }) => {
  await assertRejects(
    () => buildWithTestSidecar({ ...minimalPayload, input: [...input] }),
    Error,
    name,
  );
});

test('buildTargetPayload wires OpenAI Responses tooling guards', async () => {
  await assertRejects(
    () => buildWithTestSidecar({
      ...minimalPayload,
      input: [{ type: 'function_call_output', call_id: 'call_1', output: 'ok', caller: { type: 'program', caller_id: 'call_prog_1' } }],
    }),
    Error,
    'program caller',
  );
  await assertRejects(
    () => buildWithTestSidecar({ ...minimalPayload, tools: [{ type: 'programmatic_tool_calling' }] }),
    Error,
    'Programmatic',
  );
});

test('buildTargetPayload preserves required tool choice without declarations', async () => {
  const result = await buildWithTestSidecar({ ...minimalPayload, tools: null, tool_choice: 'required' });
  assertEquals(result.target.tool_choice, { type: 'any' });
});

test.each(['function_call_output', 'custom_tool_call_output'] as const)('buildTargetPayload maps input_file in %s to a document', async type => {
  const result = await buildWithTestSidecar({
    ...minimalPayload,
    input: [
      ...(type === 'function_call_output'
        ? [{ type: 'function_call' as const, call_id: 'call_1', name: 'lookup', arguments: '{}' }]
        : [{ type: 'custom_tool_call' as const, call_id: 'call_1', name: 'lookup', input: '{}' }]),
      { type, call_id: 'call_1', output: [{ type: 'input_file', file_id: 'file_1' }] },
    ],
  });
  const user = result.target.messages.find(message => message.role === 'user');
  assertEquals(user, {
    role: 'user',
    content: [{
      type: 'tool_result', tool_use_id: 'call_1', content: [{ type: 'document', source: { type: 'file', file_id: 'file_1' } }],
      cache_control: { type: 'ephemeral' },
    }],
  });
});

test.each([
  { name: 'file_id', part: { type: 'input_file' as const, file_id: 'file_1' }, source: { type: 'file', file_id: 'file_1' } },
  { name: 'file_url', part: { type: 'input_file' as const, file_url: 'https://example.com/a.pdf' }, source: { type: 'url', url: 'https://example.com/a.pdf' } },
  { name: 'file_data data URL', part: { type: 'input_file' as const, file_data: 'data:application/pdf;base64,JVBERi0=' }, source: { type: 'base64', media_type: 'application/pdf', data: 'JVBERi0=' } },
])('buildTargetPayload maps input_file $name to a Messages document', async ({ part, source }) => {
  const result = await buildWithTestSidecar({
    ...minimalPayload,
    input: [{ type: 'message', role: 'user', content: [part] }],
  });
  assertEquals(result.target.messages.at(-1), { role: 'user', content: [{ type: 'document', source }] });
});

test('buildTargetPayload rejects file assistant content', async () => {
  await assertRejects(
    () => buildWithTestSidecar({
      ...minimalPayload,
      input: [{ type: 'message', role: 'assistant', content: [{ type: 'input_file', file_id: 'file_1' }] }],
    }),
    Error,
    'input_file assistant content',
  );
});

test('buildTargetPayload preserves assistant input_text', async () => {
  const result = await buildWithTestSidecar({
    ...minimalPayload,
    input: [{ type: 'message', role: 'assistant', content: [{ type: 'input_text', text: 'prior reply' }] }],
  });

  assertEquals(result.target.messages, [
    { role: 'assistant', content: [{ type: 'text', text: 'prior reply', cache_control: { type: 'ephemeral' } }] },
  ]);
});

test('buildTargetPayload rejects assistant images', async () => {
  await assertRejects(
    () => buildWithTestSidecar({
      ...minimalPayload,
      input: [{ type: 'message', role: 'assistant', content: [{ type: 'input_image', image_url: 'https://example.com/a.png', detail: 'auto' }] }],
    }),
    Error,
    'input_image assistant content',
  );
});

test.each(['function_call_output', 'custom_tool_call_output'] as const)('buildTargetPayload passes file_id-only images through in %s', async type => {
  const result = await buildWithTestSidecar({
    ...minimalPayload,
    input: [
      ...(type === 'function_call_output'
        ? [{ type: 'function_call' as const, call_id: 'call_1', name: 'lookup', arguments: '{}' }]
        : [{ type: 'custom_tool_call' as const, call_id: 'call_1', name: 'lookup', input: '{}' }]),
      { type, call_id: 'call_1', output: [{ type: 'input_image', file_id: 'file_1', detail: 'auto' }] },
    ],
  });
  assertEquals(result.target.messages, [
    {
      role: 'assistant',
      // The freeform arm keeps its verbatim string; the function arm states the
      // argument object it declares.
      content: [{ type: 'tool_use', id: 'call_1', name: 'lookup', input: type === 'function_call_output' ? {} : { input: '{}' } }],
    },
    {
      role: 'user',
      content: [{ type: 'tool_result', tool_use_id: 'call_1', content: [{ type: 'image', source: { type: 'file', file_id: 'file_1' } }], cache_control: { type: 'ephemeral' } }],
    },
  ]);
});

test('buildTargetPayload forwards empty reasoning.effort verbatim', async () => {
  const result = await buildWithTestSidecar({
    ...minimalPayload,
    reasoning: { effort: '' },
  });

  assertEquals(result.target.output_config, { effort: '' });
  assertFalse('thinking' in result.target);
});

test('buildTargetPayload defaults max_tokens to ANTHROPIC_MESSAGES_FALLBACK_MAX_TOKENS when neither source nor fallbackMaxOutputTokens supplies one', async () => {
  const result = await buildWithTestSidecar({
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

  assertEquals(result.target.max_tokens, ANTHROPIC_MESSAGES_FALLBACK_MAX_TOKENS);
});

test('buildTargetPayload uses fallbackMaxOutputTokens over the gateway const when the source omitted max_output_tokens', async () => {
  const result = await buildWithTestSidecar(
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

test('buildTargetPayload omits the signature for a reasoning with no encrypted_content', async () => {
  const result = await buildWithTestSidecar({
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

  assertEquals(assistant.content[0], { signature: '', type: 'thinking', thinking: 'trace' });
});

test('buildTargetPayload drops reasoning input without readable summary', async () => {
  const result = await buildWithTestSidecar({
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

test('buildTargetPayload wraps custom tools as single-string function tools and records their names', async () => {
  const result = await buildWithTestSidecar({
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

  assertEquals(result.target.tools, [
    {
      type: 'custom',
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
  assertEquals(result.target.tool_choice, { type: 'tool', name: 'apply_patch', disable_parallel_tool_use: false });
});

test.each(['file_search'])('buildTargetPayload rejects unsupported tool type %s', async type => {
  await assertRejects(
    () => buildWithTestSidecar({ ...minimalPayload, tools: [{ type } as unknown as OpenAIResponsesTool] }),
    Error,
    `Cannot translate OpenAI Responses tool type '${type}'.`,
  );
});

test.each(['web_search'])('buildTargetPayload rejects unsupported string tool choice %s', async toolChoice => {
  await assertRejects(
    () => buildWithTestSidecar({ ...minimalPayload, tool_choice: toolChoice as unknown as typeof minimalPayload.tool_choice }),
    Error,
    `Cannot translate OpenAI Responses tool choice '${toolChoice}'.`,
  );
});

test.each(['web_search'])('buildTargetPayload rejects unsupported object tool choice type %s', async type => {
  await assertRejects(
    () => buildWithTestSidecar({ ...minimalPayload, tool_choice: { type } as unknown as typeof minimalPayload.tool_choice }),
    Error,
    `Cannot translate OpenAI Responses tool choice type '${type}'.`,
  );
});

test.each([
  { name: 'string', output: 'ok', expected: 'ok' },
  { name: 'text array', output: [{ type: 'input_text' as const, text: 'first\n' }, { type: 'input_text' as const, text: 'second' }], expected: [{ type: 'text', text: 'first\n' }, { type: 'text', text: 'second' }] },
  { name: 'empty array', output: [], expected: '' },
])('buildTargetPayload projects custom_tool_call history with $name output into wrapped tool_use shape', async ({ output, expected }) => {
  const result = await buildWithTestSidecar({
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
        output,
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
        content: expected,
        // Last block of the last message — cache_control attached by
        // applyLastMessageCacheBreakpoint.
        cache_control: { type: 'ephemeral' },
      },
    ],
  });
});

test('buildTargetPayload flattens namespace functions collision-safely and maps replay history', async () => {
  const namespaceTool: OpenAIResponsesTool = {
    type: 'namespace',
    name: 'web',
    description: 'Web tools.',
    tools: [{
      type: 'function',
      name: 'run',
      description: 'Access the web.',
      parameters: { type: 'object', properties: { search_query: { type: 'array' } } },
      strict: false,
    }],
  };
  const payload: OpenAIResponsesRequestPayloadEx = {
    ...minimalPayload,
    input: [
      { type: 'message', role: 'user', content: 'search' },
      { type: 'function_call', call_id: 'call_web', namespace: 'web', name: 'run', arguments: '{"search_query":[]}', status: 'completed' },
    ],
    tools: [
      { type: 'function', name: 'web_run', parameters: { type: 'object' }, strict: false },
      namespaceTool,
    ],
    tool_choice: { type: 'function', name: 'web.run' },
  };
  const result = await buildWithTestSidecar(payload);

  // A grouped declaration and the flat one it would collide with both reach
  // this wire, so the group's spelling has to avoid the name already in use.
  assertEquals(result.target.tools?.map(tool => 'name' in tool ? tool.name : undefined), ['web_run', 'web_run_2']);
  assertEquals(result.target.tools, [
    {
      type: 'custom',
      name: 'web_run',
      input_schema: { type: 'object' },
      strict: false,
    },
    {
      type: 'custom',
      name: 'web_run_2',
      description: 'Web tools.\n\nAccess the web.',
      input_schema: { type: 'object', properties: { search_query: { type: 'array' } } },
      strict: false,
      cache_control: { type: 'ephemeral' },
    },
  ]);
  assertEquals(result.target.messages[1], {
    role: 'assistant',
    content: [{
      type: 'tool_use',
      id: 'call_web',
      name: 'web_run_2',
      input: { search_query: [] },
      cache_control: { type: 'ephemeral' },
    }],
  });
  assertEquals(result.target.tool_choice, { type: 'tool', name: 'web_run_2', disable_parallel_tool_use: false });
});

test('buildTargetPayload gives a schema-less function tool the empty object schema', async () => {
  const result = await buildWithTestSidecar({
    ...minimalPayload,
    tools: [{ type: 'function', name: 'ping' }],
  });

  assertEquals(result.target.tools, [
    {
      type: 'custom',
      name: 'ping',
      input_schema: { type: 'object', properties: {} },
      cache_control: { type: 'ephemeral' },
    },
  ]);
});

test.each(['function_call_output', 'custom_tool_call_output'] as const)('buildTargetPayload maps multimodal %s into tool_result image and text blocks', async type => {
  const result = await buildWithTestSidecar({
    model: 'claude-test',
    input: [
      type === 'function_call_output'
        ? { type: 'function_call', call_id: 'call_1', name: 'screenshot', arguments: '{}', status: 'completed' }
        : { type: 'custom_tool_call', call_id: 'call_1', name: 'screenshot', input: 'capture()' },
      {
        type,
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

test('buildTargetPayload maps incomplete function output to an Anthropic tool error', async () => {
  const result = await buildWithTestSidecar({
    ...minimalPayload,
    input: [
      { type: 'function_call', call_id: 'call_exec', name: 'exec', arguments: '{}', status: 'completed' },
      { type: 'function_call_output', call_id: 'call_exec', status: 'incomplete', output: 'failed' },
    ],
  });

  assertEquals(result.target.messages[1], {
    role: 'user',
    content: [{
      type: 'tool_result', tool_use_id: 'call_exec', content: 'failed', is_error: true,
      cache_control: { type: 'ephemeral' },
    }],
  });
});

test('buildTargetPayload throws on a stray web_search_call input item (shim owns the reverse path)', async () => {
  // The OpenAI Responses web-search shim rewrites web_search_call input items into
  // upstream function_call + function_call_output pairs before this
  // translator runs. Reaching the translator with a raw web_search_call
  // means the shim regressed; the translator surfaces a loud error so the
  // bug is caught rather than silently dropping search context.
  await assertRejects(
    () => buildWithTestSidecar({
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
    'Invalid input item: {"type":"web_search_call"',
  );
});

test('buildTargetPayload extracts flat text.format json_schema into output_config.format and drops OpenAI-only fields', async () => {
  const schema = { type: 'object', properties: { x: { type: 'string' } }, required: ['x'], additionalProperties: false };
  const result = await buildWithTestSidecar({
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

test('buildTargetPayload hoists leading role:"system" to top-level system field', async () => {
  const result = await buildWithTestSidecar(
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
  );

  assertEquals(result.target.system, [{ type: 'text', text: 'be terse', cache_control: { type: 'ephemeral' } }]);
  assertEquals(result.target.messages.length, 1);
  assertEquals(result.target.messages[0].role, 'user');
});

test('buildTargetPayload throws when a system input message contains an image part', async () => {
  await assertRejects(
    () =>
      buildWithTestSidecar(
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
      ),
    Error,
    "Invalid 'input_image' content part in system message",
  );
});

test('keeps an empty assistant message as the turn that separates two client runs', async () => {
  // Dropping it would leave two adjacent user messages, which this wire merges
  // into one turn, losing the boundary the client stated.
  const result = await buildWithTestSidecar({
    model: 'gpt-test',
    input: [
      { type: 'message', role: 'user', content: 'one' },
      { type: 'message', role: 'assistant', content: [] },
      { type: 'message', role: 'user', content: 'two' },
    ],
  });
  assertEquals(result.target.messages.map(message => message.role), ['user', 'assistant', 'user']);
});
