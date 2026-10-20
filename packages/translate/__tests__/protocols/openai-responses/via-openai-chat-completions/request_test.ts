import { test } from 'vitest';

import { buildTargetRequest as buildTargetRequestWithSidecar } from '../../../../src/protocols/openai-responses/via-openai-chat-completions/request.ts';
import { createTestSidecarCodec } from '../../../round-trip/sidecar-codec.ts';
import type { OpenAIChatCompletionsAssistantMessageEx, OpenAIChatCompletionsFunctionTool, OpenAIChatCompletionsToolMessage } from '@floway-dev/protocols/openai-chat-completions';
import type { OpenAIResponsesRequestPayloadEx, OpenAIResponsesInputMultiAgentCallOutputItem, OpenAIResponsesTool, OpenAIResponsesToolChoice } from '@floway-dev/protocols/openai-responses';
import { assertEquals, assertRejects } from '@floway-dev/test-utils';

const buildWithTestSidecar = (payload: Parameters<typeof buildTargetRequestWithSidecar>[0]) =>
  buildTargetRequestWithSidecar(payload, createTestSidecarCodec());

test('buildTargetRequest accepts an implicit message discriminator', async () => {
  const result = await buildWithTestSidecar({
    model: 'gpt-test',
    input: [{ role: 'system', content: 'rules' }],
  });

  assertEquals(result.target.messages, [
    { role: 'system', content: 'rules' },
  ]);
});

test('buildTargetRequest rejects an agent_message that no interceptor lowered', async () => {
  await assertRejects(
    () => buildWithTestSidecar({
      model: 'gpt-test',
      input: [{
        type: 'agent_message',
        author: '/root/reviewer',
        recipient: '/root',
        content: [{ type: 'input_text', text: 'done' }],
      }],
    }),
    Error,
    "Invalid input item type 'agent_message'.",
  );
});

test('buildTargetRequest merges adjacent assistant reasoning text and tool calls', async () => {
  const result = await buildWithTestSidecar({
    model: 'gpt-test',
    input: [
      { type: 'message', role: 'user', content: 'Hi' },
      {
        type: 'reasoning',
        id: 'rs_1',
        summary: [{ type: 'summary_text', text: 'trace' }],
      },
      {
        type: 'message',
        role: 'assistant',
        content: [{ type: 'output_text', text: 'Hello' }],
      },
      {
        type: 'function_call',
        call_id: 'call_1',
        name: 'lookup',
        arguments: '{"q":"x"}',
        status: 'completed',
      },
      {
        type: 'function_call_output',
        call_id: 'call_1',
        output: '42',
      },
    ],
    instructions: 'system prompt',
    temperature: 0.7,
    top_p: 0.8,
    max_output_tokens: 256,
    tools: null,
    tool_choice: 'auto',
    metadata: { trace_id: 'trace_123' },
    stream: false,
    store: false,
    parallel_tool_calls: true,
    text: {
      format: {
        type: 'json_schema',
        name: 'shape',
        strict: true,
        schema: { type: 'object' },
      },
    },
    prompt_cache_key: 'cache-key',
    safety_identifier: 'safe-id',
    reasoning: { effort: 'medium' },
  });

  assertEquals(result.target.model, 'gpt-test');
  assertEquals(result.target.max_tokens, 256);
  assertEquals(result.target.metadata, { trace_id: 'trace_123' });
  assertEquals(result.target.store, false);
  assertEquals(result.target.parallel_tool_calls, true);
  assertEquals(result.target.response_format, {
    type: 'json_schema',
    json_schema: {
      name: 'shape',
      strict: true,
      schema: { type: 'object' },
    },
  });
  assertEquals(result.target.prompt_cache_key, 'cache-key');
  assertEquals(result.target.safety_identifier, 'safe-id');
  assertEquals(result.target.reasoning_effort, 'medium');
  assertEquals(result.target.messages, [
    { role: 'system', content: 'system prompt' },
    { role: 'user', content: 'Hi' },
    {
      role: 'assistant',
      content: 'Hello',
      reasoning_text: 'trace',
      tool_calls: [
        {
          id: 'call_1',
          type: 'function',
          function: {
            name: 'lookup',
            arguments: '{"q":"x"}',
          },
        },
      ],
    } as OpenAIChatCompletionsAssistantMessageEx,
    {
      role: 'tool',
      tool_call_id: 'call_1',
      content: '42',
    },
  ]);
});

test('buildTargetRequest preserves explicit null prompt cache and safety fields', async () => {
  const result = await buildWithTestSidecar({
    model: 'gpt-test',
    input: 'hello',
    prompt_cache_key: null,
    safety_identifier: null,
  });

  assertEquals('prompt_cache_key' in result.target, true);
  assertEquals(result.target.prompt_cache_key, null);
  assertEquals('safety_identifier' in result.target, true);
  assertEquals(result.target.safety_identifier, null);
});

test('buildTargetRequest omits response_format when OpenAI Responses text.format is absent', async () => {
  const result = await buildWithTestSidecar({
    model: 'gpt-test',
    input: 'Hi',
    text: {},
  });

  assertEquals('response_format' in result.target, false);
});

test('buildTargetRequest omits a null text format from the Chat response-format field', async () => {
  const result = await buildWithTestSidecar({
    model: 'gpt-test',
    input: 'Hi',
    text: null,
  });

  assertEquals(result.target.response_format, undefined);
});

test('buildTargetRequest reshapes flat json_schema text format into OpenAI Chat Completions shape', async () => {
  const schema = {
    type: 'object',
    properties: { ok: { type: 'boolean' } },
    required: ['ok'],
  };
  const result = await buildWithTestSidecar({
    model: 'gpt-test',
    input: 'Hi',
    text: {
      format: {
        type: 'json_schema',
        name: 'review_output',
        strict: true,
        schema,
      },
    },
  });

  assertEquals(result.target.response_format, {
    type: 'json_schema',
    json_schema: {
      name: 'review_output',
      strict: true,
      schema,
    },
  });
});

test('buildTargetRequest passes through plain text format without wrapping', async () => {
  const result = await buildWithTestSidecar({
    model: 'gpt-test',
    input: 'Hi',
    text: { format: { type: 'text' } },
  });

  assertEquals(result.target.response_format, { type: 'text' });
});

test('buildTargetRequest does not double-wrap an already-wrapped json_schema', async () => {
  const result = await buildWithTestSidecar({
    model: 'gpt-test',
    input: 'Hi',
    text: {
      format: {
        type: 'json_schema',
        json_schema: { name: 'already', strict: false, schema: {} },
      } as unknown as NonNullable<NonNullable<OpenAIResponsesRequestPayloadEx['text']>['format']>,
    },
  });

  assertEquals(result.target.response_format, {
    type: 'json_schema',
    json_schema: { name: 'already', strict: false, schema: {} },
  });
});

test.each(['web_search_preview', 'file_search', 'image_generation', 'local_shell'])('buildTargetRequest rejects unsupported tool type %s', async type => {
  await assertRejects(
    () => buildWithTestSidecar({
      model: 'gpt-test',
      input: [{ type: 'message', role: 'user', content: 'Hi' }],
      tools: [{ type } as unknown as OpenAIResponsesTool],
    }),
    Error,
    `Cannot translate OpenAI Responses tool type '${type}' to OpenAI Chat Completions.`,
  );
});

test('buildTargetRequest omits parameters and strict for a schema-less function tool', async () => {
  const result = await buildWithTestSidecar({
    model: 'gpt-test',
    input: [{ type: 'message', role: 'user', content: 'Hi' }],
    tools: [{ type: 'function', name: 'ping' }],
  });

  // `toEqual` treats an undefined-valued key as absent, so the keys are
  // compared directly: emitting `parameters: undefined` is the regression.
  assertEquals(Object.keys((result.target.tools![0] as OpenAIChatCompletionsFunctionTool).function), ['name']);
});

test.each(['web_search', 'file_search'])('buildTargetRequest rejects unsupported string tool choice %s', async toolChoice => {
  await assertRejects(
    () => buildWithTestSidecar({ model: 'gpt-test', input: 'Hi', tool_choice: toolChoice as OpenAIResponsesToolChoice }),
    Error,
    `Cannot translate OpenAI Responses tool choice '${toolChoice}' to OpenAI Chat Completions.`,
  );
});

test.each(['web_search_preview', 'file_search'])('buildTargetRequest rejects unsupported object tool choice type %s', async type => {
  await assertRejects(
    () => buildWithTestSidecar({ model: 'gpt-test', input: 'Hi', tool_choice: { type } as unknown as OpenAIResponsesToolChoice }),
    Error,
    `Cannot translate OpenAI Responses tool choice type '${type}' to OpenAI Chat Completions.`,
  );
});

test('buildTargetRequest keeps function tool_choice', async () => {
  const resultWithFunctionChoice = await buildWithTestSidecar({
    model: 'gpt-test',
    input: [{ type: 'message', role: 'user', content: 'Hi' }],
    instructions: null,
    temperature: null,
    top_p: null,
    max_output_tokens: null,
    tools: null,
    tool_choice: {
      type: 'function' as const,
      name: 'get_weather',
    },
    metadata: null,
    stream: null,
    store: null,
    parallel_tool_calls: null,
    text: null,
  });

  assertEquals(resultWithFunctionChoice.target.tool_choice, {
    type: 'function',
    function: { name: 'get_weather' },
  });
});

test.each(['auto', 'required', 'none'] as const)('buildTargetRequest keeps supported string tool choice %s', async toolChoice => {
  const result = await buildWithTestSidecar({
    model: 'gpt-test',
    input: [{ type: 'message', role: 'user', content: 'Hi' }],
    instructions: null,
    temperature: null,
    top_p: null,
    max_output_tokens: null,
    tools: null,
    tool_choice: toolChoice,
    metadata: null,
    stream: null,
    store: null,
    parallel_tool_calls: null,
    text: null,
  });

  assertEquals(result.target.tool_choice, toolChoice);
});

test('buildTargetRequest wraps custom tools as single-string function tools and records their names', async () => {
  const result = await buildWithTestSidecar({
    model: 'gpt-test',
    input: 'hi',
    instructions: null,
    temperature: null,
    top_p: null,
    max_output_tokens: null,
    tools: [
      {
        type: 'custom',
        name: 'apply_patch',
        description: 'apply a patch',
        format: { type: 'grammar', syntax: 'lark', definition: 'start: "ok"' },
      },
    ],
    tool_choice: { type: 'custom' as const, name: 'apply_patch' },
    metadata: null,
    stream: null,
    store: null,
    parallel_tool_calls: null,
    text: null,
  });

  assertEquals(result.customToolNames.has('apply_patch'), true);
  assertEquals(result.target.tools, [
    {
      type: 'function',
      function: {
        name: 'apply_patch',
        description: 'apply a patch',
        parameters: {
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
        strict: false,
      },
    },
  ]);
  assertEquals(result.target.tool_choice, { type: 'function', function: { name: 'apply_patch' } });
});

test.each([
  { name: 'string', output: 'ok', expected: 'ok' },
  { name: 'text array', output: [{ type: 'input_text' as const, text: 'first\n' }, { type: 'input_text' as const, text: 'second' }], expected: 'first\nsecond' },
  { name: 'empty array', output: [], expected: '' },
])('buildTargetRequest projects custom_tool_call history with $name output into wrapped tool_calls shape', async ({ output, expected }) => {
  const result = await buildWithTestSidecar({
    model: 'gpt-test',
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
    max_output_tokens: null,
    tools: [{ type: 'custom', name: 'apply_patch' }],
    tool_choice: 'auto' as OpenAIResponsesToolChoice,
    metadata: null,
    stream: null,
    store: null,
    parallel_tool_calls: null,
    text: null,
  });

  const assistant = result.target.messages.find(m => m.role === 'assistant');
  if (!assistant) throw new Error('expected assistant message');
  assertEquals(assistant.tool_calls?.[0], {
    id: 'call_1',
    type: 'function',
    function: {
      name: 'apply_patch',
      arguments: JSON.stringify({ input: '*** Begin Patch\n*** End Patch' }),
    },
  });

  const tool = result.target.messages.find(m => m.role === 'tool');
  assertEquals(tool, {
    role: 'tool',
    tool_call_id: 'call_1',
    content: expected,
  });
});

test.each([
  { name: 'program', input: [{ type: 'program', id: 'prog_1', call_id: 'call_prog_1', code: 'return 1', fingerprint: 'opaque' }] },
  { name: 'program_output', input: [{ type: 'program_output', id: 'prog_out_1', call_id: 'call_prog_1', result: '1', status: 'completed' }] },
  { name: 'multi_agent_call', input: [{ type: 'multi_agent_call', action: 'spawn_agent', arguments: '{}', call_id: 'call_1' }] },
  { name: 'multi_agent_call_output', input: [{ type: 'multi_agent_call_output', action: 'spawn_agent', call_id: 'call_1', output: [] as OpenAIResponsesInputMultiAgentCallOutputItem['output'] }] },
  { name: 'context_compaction', input: [{ type: 'context_compaction', encrypted_content: 'opaque' }] },
  { name: 'item_reference', input: [{ type: 'item_reference', id: 'msg_1' }] },
] as const)('buildTargetRequest rejects OpenAI-Responses-only $name input', async ({ name, input }) => {
  await assertRejects(
    () => buildWithTestSidecar({ model: 'gpt-test', input: [...input] }),
    Error,
    `Invalid input item type '${name}'`,
  );
});

test('buildTargetRequest wires OpenAI Responses tooling guards', async () => {
  await assertRejects(
    () => buildWithTestSidecar({
      model: 'gpt-test',
      input: [{ type: 'function_call_output', call_id: 'call_1', output: 'ok', caller: { type: 'program', caller_id: 'call_prog_1' } }],
    }),
    Error,
    'program caller',
  );
  await assertRejects(
    () => buildWithTestSidecar({ model: 'gpt-test', input: 'hi', tools: [{ type: 'programmatic_tool_calling' }] }),
    Error,
    'Programmatic',
  );
});

test('buildTargetRequest accepts null tool_choice', async () => {
  const result = await buildWithTestSidecar({ model: 'gpt-test', input: 'hi', tool_choice: null });
  assertEquals(result.target.tool_choice, undefined);
});

test.each(['function_call_output', 'custom_tool_call_output'] as const)('buildTargetRequest rejects input_file in %s', async type => {
  await assertRejects(
    () => buildWithTestSidecar({
      model: 'gpt-test',
      input: [{ type, call_id: 'call_1', output: [{ type: 'input_file', file_id: 'file_1' }] }],
    }),
    Error,
    'input_file tool output',
  );
});

test('buildTargetRequest rejects file assistant content', async () => {
  await assertRejects(
    () => buildWithTestSidecar({
      model: 'gpt-test',
      input: [{ type: 'message', role: 'assistant', content: [{ type: 'input_file', file_id: 'file_1' }] }],
    }),
    Error,
    'input_file assistant content',
  );
});

test('buildTargetRequest rejects image assistant content', async () => {
  await assertRejects(
    () => buildWithTestSidecar({
      model: 'gpt-test',
      input: [{ type: 'message', role: 'assistant', content: [{ type: 'input_image', image_url: 'https://example.com/a.png', detail: 'auto' }] }],
    }),
    Error,
    'input_image assistant content',
  );
});

test('buildTargetRequest rejects file_id-only images', async () => {
  await assertRejects(
    () => buildWithTestSidecar({
      model: 'gpt-test',
      input: [{ type: 'message', role: 'user', content: [{ type: 'input_image', file_id: 'file_1', detail: 'auto' }] }],
    }),
    Error,
    'file_id-only image content',
  );
});

test('buildTargetRequest forwards image details OpenAI Chat Completions does not publish', async () => {
  const result = await buildWithTestSidecar({
    model: 'gpt-test',
    input: [{
      type: 'message',
      role: 'user',
      content: [
        { type: 'input_image', image_url: 'https://example.com/a.png', detail: 'original' },
        { type: 'input_image', image_url: 'https://example.com/b.png', detail: 'ultra' },
      ],
    }],
  });

  assertEquals(result.target.messages[0].content, [
    { type: 'image_url', image_url: { url: 'https://example.com/a.png', detail: 'original' } },
    { type: 'image_url', image_url: { url: 'https://example.com/b.png', detail: 'ultra' } },
  ]);
});

test('buildTargetRequest omits image detail when the client sends none', async () => {
  const result = await buildWithTestSidecar({
    model: 'gpt-test',
    input: [{ type: 'message', role: 'user', content: [{ type: 'input_image', image_url: 'data:image/png;base64,AQID' }] }],
  });

  assertEquals(result.target.messages, [
    { role: 'user', content: [{ type: 'image_url', image_url: { url: 'data:image/png;base64,AQID' } }] },
  ]);
});

test('buildTargetRequest omits image detail when the client sends null', async () => {
  const result = await buildWithTestSidecar({
    model: 'gpt-test',
    input: [{ type: 'message', role: 'user', content: [{ type: 'input_image', image_url: 'data:image/png;base64,AQID', detail: null }] }],
  });

  assertEquals(result.target.messages[0].content, [{ type: 'image_url', image_url: { url: 'data:image/png;base64,AQID' } }]);
});

test.each(['function_call_output', 'custom_tool_call_output'] as const)('buildTargetRequest omits image detail on lifted %s images', async type => {
  const result = await buildWithTestSidecar({
    model: 'gpt-test',
    input: [
      type === 'function_call_output'
        ? { type: 'function_call', call_id: 'call_1', name: 'screenshot', arguments: '{}', status: 'completed' }
        : { type: 'custom_tool_call', call_id: 'call_1', name: 'screenshot', input: 'capture()' },
      {
        type,
        call_id: 'call_1',
        output: [{ type: 'input_image', image_url: 'data:image/png;base64,AQID' }],
      },
    ],
  });

  assertEquals(result.target.messages.at(-1)?.content, [
    { type: 'text', text: 'Image output from tool call call_1:' },
    { type: 'image_url', image_url: { url: 'data:image/png;base64,AQID' } },
  ]);
});

test('buildTargetRequest throws on a stray web_search_call input item (shim owns the reverse path)', async () => {
  // The OpenAI Responses web-search shim rewrites web_search_call input items into
  // upstream function_call + function_call_output pairs before this
  // translator runs. Reaching the translator with a raw web_search_call
  // means the shim regressed; the translator surfaces a loud error so the
  // bug is caught rather than silently dropping search context.
  await assertRejects(
    () => buildWithTestSidecar({
      model: 'gpt-test',
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

test('buildTargetRequest throws on a stray compaction_trigger input item (compact-shim owns the strip)', async () => {
  // The compact-shim is structurally required on non-openai-responses targets and
  // strips compaction_trigger items before reaching this translator.
  // Reaching here with one in input means the shim disengaged; the
  // translator's catch-all guard surfaces the regression.
  await assertRejects(
    () => buildWithTestSidecar({
      model: 'gpt-test',
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
    "Invalid input item type 'compaction_trigger'",
  );
});

test('buildTargetRequest throws on a stray compaction input item (compact-shim owns the expansion)', async () => {
  // The compact-shim expands its own shim-encoded compaction items inline
  // before reaching this translator and round-trips foreign compactions
  // back to the upstream as raw items. Either way the translator should
  // never see one.
  await assertRejects(
    () => buildWithTestSidecar({
      model: 'gpt-test',
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
    "Invalid input item type 'compaction'",
  );
});

test('buildTargetRequest lifts tool-output images into a following user message', async () => {
  const result = await buildWithTestSidecar({
    model: 'gpt-test',
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
    stream: false,
    store: false,
    parallel_tool_calls: true,
  });

  assertEquals(result.target.messages, [
    {
      role: 'assistant',
      content: null,
      tool_calls: [{
        id: 'call_1',
        type: 'function',
        function: { name: 'screenshot', arguments: '{}' },
      }],
    },
    { role: 'tool', tool_call_id: 'call_1', content: 'captured' },
    {
      role: 'user',
      content: [
        { type: 'text', text: 'Image output from tool call call_1:' },
        { type: 'image_url', image_url: { url: 'data:image/png;base64,AQID', detail: 'high' } },
      ],
    },
  ]);
});

test('buildTargetRequest keeps grouped tool results contiguous before lifted images', async () => {
  const result = await buildWithTestSidecar({
    model: 'gpt-test',
    input: [
      { type: 'function_call', call_id: 'call_a', name: 'capture_a', arguments: '{}', status: 'completed' },
      { type: 'function_call', call_id: 'call_b', name: 'capture_b', arguments: '{}', status: 'completed' },
      { type: 'custom_tool_call', call_id: 'call_c', name: 'inspect', input: 'raw output' },
      {
        type: 'function_call_output',
        call_id: 'call_a',
        output: [
          { type: 'input_image', image_url: 'data:image/png;base64,AAAA', detail: 'low' },
          { type: 'input_image', image_url: 'data:image/png;base64,AAAB', detail: 'high' },
        ],
      },
      {
        type: 'function_call_output',
        call_id: 'call_b',
        output: [
          { type: 'input_text', text: 'second capture' },
          { type: 'input_image', image_url: 'data:image/png;base64,BBBB', detail: 'auto' },
        ],
      },
      {
        type: 'custom_tool_call_output',
        call_id: 'call_c',
        output: [
          { type: 'input_text', text: 'inspection complete' },
          { type: 'input_image', image_url: 'https://example.com/inspection.png', detail: 'original' },
        ],
      },
    ],
  });

  assertEquals(result.target.messages.map(message => message.role), ['assistant', 'tool', 'tool', 'tool', 'user']);
  assertEquals(result.target.messages.slice(1, 4).map(message => (message as OpenAIChatCompletionsToolMessage).tool_call_id), ['call_a', 'call_b', 'call_c']);
  assertEquals(result.target.messages[1].content, 'Image output is attached in the following user message.');
  assertEquals(result.target.messages[2].content, 'second capture');
  assertEquals(result.target.messages[3].content, 'inspection complete');
  assertEquals(result.target.messages[4].content, [
    { type: 'text', text: 'Image output from tool call call_a:' },
    { type: 'image_url', image_url: { url: 'data:image/png;base64,AAAA', detail: 'low' } },
    { type: 'image_url', image_url: { url: 'data:image/png;base64,AAAB', detail: 'high' } },
    { type: 'text', text: 'Image output from tool call call_b:' },
    { type: 'image_url', image_url: { url: 'data:image/png;base64,BBBB', detail: 'auto' } },
    { type: 'text', text: 'Image output from tool call call_c:' },
    { type: 'image_url', image_url: { url: 'https://example.com/inspection.png', detail: 'original' } },
  ]);
});

test('buildTargetRequest places lifted images before a later source message', async () => {
  for (const trailing of [
    { type: 'message' as const, role: 'user' as const, content: 'new user turn' },
    { type: 'message' as const, role: 'system' as const, content: 'new system turn' },
  ]) {
    const result = await buildWithTestSidecar({
      model: 'gpt-test',
      input: [
        { type: 'function_call', call_id: 'call_1', name: 'capture', arguments: '{}', status: 'completed' },
        {
          type: 'function_call_output',
          call_id: 'call_1',
          output: [{ type: 'input_image', image_url: 'data:image/png;base64,AAAA', detail: 'auto' }],
        },
        trailing,
      ],
    });

    assertEquals(result.target.messages.map(message => message.role), ['assistant', 'tool', 'user', trailing.role]);
    assertEquals(result.target.messages.at(-1)?.content, trailing.content);
  }
});

// ── Native field forwarding ──

test('buildTargetRequest maps text.verbosity onto verbosity', async () => {
  const result = await buildWithTestSidecar({
    model: 'gpt-test',
    input: [{ type: 'message', role: 'user', content: 'hi' }],
    text: { verbosity: 'low' },
  });

  assertEquals(result.target.verbosity, 'low');
});

test('buildTargetRequest co-emits reasoning.effort onto reasoning_effort and service_tier verbatim', async () => {
  const result = await buildWithTestSidecar({
    model: 'gpt-test',
    input: [{ type: 'message', role: 'user', content: 'hi' }],
    reasoning: { effort: 'xhigh' },
    service_tier: 'priority',
  });

  assertEquals(result.target.reasoning_effort, 'xhigh');
  assertEquals(result.target.service_tier, 'priority');
});

test('buildTargetRequest forwards empty reasoning.effort verbatim', async () => {
  const result = await buildWithTestSidecar({
    model: 'gpt-test',
    input: [{ type: 'message', role: 'user', content: 'hi' }],
    reasoning: { effort: '' },
  });

  assertEquals(result.target.reasoning_effort, '');
});

test('buildTargetRequest drops reasoning.summary (OpenAI Chat Completions has no slot)', async () => {
  const result = await buildWithTestSidecar({
    model: 'gpt-test',
    input: [{ type: 'message', role: 'user', content: 'hi' }],
    reasoning: { effort: 'medium', summary: 'concise' },
  });

  assertEquals(result.target.reasoning_effort, 'medium');
  assertEquals('reasoning_summary' in result.target, false);
});

test.each(['system', 'developer'] as const)('preserves %s text part boundaries', async role => {
  const result = await buildWithTestSidecar({ model: 'gpt-test', input: [{ type: 'message', role, content: [{ type: 'input_text', text: 'a' }, { type: 'input_text', text: 'b' }] }] });
  assertEquals(result.target.messages, [{ role, content: [{ type: 'text', text: 'a' }, { type: 'text', text: 'b' }] }]);
});
