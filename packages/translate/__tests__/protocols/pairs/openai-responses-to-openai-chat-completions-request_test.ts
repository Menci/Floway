import { test } from 'vitest';

import { buildTargetPayloadFor, pairs } from '../../composition/helpers.ts';
import { createTestSidecarCodec } from '../../round-trip/sidecar-codec.ts';
import type { OpenAIChatCompletionsAssistantMessageEx, OpenAIChatCompletionsFunctionTool, OpenAIChatCompletionsToolMessage } from '@floway-dev/protocols/openai-chat-completions';
import type { OpenAIResponsesRequestPayloadEx, OpenAIResponsesInputMultiAgentCallOutputItem, OpenAIResponsesTool, OpenAIResponsesToolChoice } from '@floway-dev/protocols/openai-responses';
import { assertEquals, assertRejects } from '@floway-dev/test-utils';

const buildWithTestSidecar = async (payload: OpenAIResponsesRequestPayloadEx) => {
  const streamed = { ...payload, stream: true };
  return {
    target: await buildTargetPayloadFor(pairs.responsesToChat[0], pairs.responsesToChat[1], streamed, { sidecarCodec: createTestSidecarCodec() }),
  };
};

test('preserves a refusal-only assistant turn between client turns', async () => {
  const { target } = await buildWithTestSidecar({
    model: 'model', input: [
      { type: 'message', role: 'user', content: 'Q' },
      { type: 'message', role: 'assistant', content: [{ type: 'refusal', refusal: 'Cannot help.' }] },
      { type: 'message', role: 'user', content: 'Why?' },
    ],
  });
  assertEquals(target.messages, [
    { role: 'user', content: 'Q' },
    { role: 'assistant', content: '', refusal: 'Cannot help.' },
    { role: 'user', content: 'Why?' },
  ]);
});

test('preserves an empty assistant turn between client turns', async () => {
  const { target } = await buildWithTestSidecar({
    model: 'model', input: [
      { type: 'message', role: 'user', content: 'A' },
      { type: 'message', role: 'assistant', content: [] },
      { type: 'message', role: 'user', content: 'B' },
    ],
  });
  assertEquals(target.messages, [
    { role: 'user', content: 'A' },
    { role: 'assistant', content: '' },
    { role: 'user', content: 'B' },
  ]);
});

test('preserves nullable metadata and service tier controls', async () => {
  const { target } = await buildWithTestSidecar({ model: 'model', input: 'hi', metadata: null, service_tier: null });
  assertEquals(target.metadata, null);
  assertEquals(target.service_tier, null);
});

test('buildTargetPayload merges adjacent assistant reasoning text and tool calls', async () => {
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
  assertEquals(result.target.max_completion_tokens, 256);
  assertEquals('max_tokens' in result.target, false);
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

test('buildTargetPayload preserves null json_schema strictness', async () => {
  const result = await buildWithTestSidecar({
    model: 'gpt-test',
    input: 'Hi',
    text: { format: { type: 'json_schema', name: 'result', schema: {}, strict: null } },
  });
  assertEquals(result.target.response_format, {
    type: 'json_schema',
    json_schema: { name: 'result', schema: {}, strict: null },
  });
});

test('buildTargetPayload does not double-wrap an already-wrapped json_schema', async () => {
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

test('buildTargetPayload omits parameters and strict for a schema-less function tool', async () => {
  const result = await buildWithTestSidecar({
    model: 'gpt-test',
    input: [{ type: 'message', role: 'user', content: 'Hi' }],
    tools: [{ type: 'function', name: 'ping' }],
  });

  // `toEqual` treats an undefined-valued key as absent, so the keys are
  // compared directly: emitting `parameters: undefined` is the regression.
  assertEquals(Object.keys((result.target.tools![0] as OpenAIChatCompletionsFunctionTool).function), ['name']);
});

test('buildTargetPayload keeps function tool_choice', async () => {
  const resultWithFunctionChoice = await buildWithTestSidecar({
    model: 'gpt-test',
    input: [{ type: 'message', role: 'user', content: 'Hi' }],
    instructions: null,
    temperature: null,
    top_p: null,
    max_output_tokens: null,
    tools: [{ type: 'function', name: 'get_weather', parameters: { type: 'object', properties: {} } }],
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

test.each(['none'] as const)('buildTargetPayload omits orphan string tool choice %s', async toolChoice => {
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

  assertEquals(result.target.tool_choice, undefined);
});

test('buildTargetPayload retains a required tool choice without declarations', async () => {
  const result = await buildWithTestSidecar({
    model: 'gpt-test',
    input: [{ type: 'message', role: 'user', content: 'Hi' }],
    instructions: null,
    temperature: null,
    top_p: null,
    max_output_tokens: null,
    tools: null,
    tool_choice: 'required',
    metadata: null,
    stream: null,
    store: null,
    parallel_tool_calls: null,
    text: null,
  });

  assertEquals(result.target.tool_choice, 'required');
});

test('buildTargetPayload wraps custom tools as single-string function tools and records their names', async () => {
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
  { name: 'text array', output: [{ type: 'input_text' as const, text: 'first\n' }, { type: 'input_text' as const, text: 'second' }], expected: 'first\nsecond' },
  { name: 'empty array', output: [], expected: '' },
])('buildTargetPayload projects custom_tool_call history with $name output into wrapped tool_calls shape', async ({ output, expected }) => {
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

test.each(['custom_tool_call_output'] as const)('buildTargetPayload lifts input_file from %s', async type => {
  const result = await buildWithTestSidecar({
    model: 'gpt-test',
    input: [
      ...(type === 'function_call_output'
        ? [{ type: 'function_call' as const, call_id: 'call_1', name: 'lookup', arguments: '{}' }]
        : [{ type: 'custom_tool_call' as const, call_id: 'call_1', name: 'lookup', input: '{}' }]),
      { type, call_id: 'call_1', output: [{ type: 'input_file', file_id: 'file_1', filename: 'result.txt' }] },
    ],
  });
  assertEquals(result.target.messages.at(-1)?.content, [
    { type: 'text', text: 'File output from tool call call_1:' },
    { type: 'file', file: { file_id: 'file_1', filename: 'result.txt' } },
  ]);
});

test('buildTargetPayload rejects file_id-only images', async () => {
  await assertRejects(
    () => buildWithTestSidecar({
      model: 'gpt-test',
      input: [{ type: 'message', role: 'user', content: [{ type: 'input_image', file_id: 'file_1', detail: 'auto' }] }],
    }),
    Error,
    'file_id-only image content',
  );
});

test('buildTargetPayload forwards image details OpenAI Chat Completions does not publish', async () => {
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

test('buildTargetPayload omits image detail when the client sends none', async () => {
  const result = await buildWithTestSidecar({
    model: 'gpt-test',
    input: [{ type: 'message', role: 'user', content: [{ type: 'input_image', image_url: 'data:image/png;base64,AQID' }] }],
  });

  assertEquals(result.target.messages, [
    { role: 'user', content: [{ type: 'image_url', image_url: { url: 'data:image/png;base64,AQID' } }] },
  ]);
});

test('buildTargetPayload lifts tool-output images into a following user message', async () => {
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

test('buildTargetPayload keeps grouped tool results contiguous before lifted images', async () => {
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

test('buildTargetPayload places lifted images before a later source message', async () => {
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

test('buildTargetPayload maps text.verbosity onto verbosity', async () => {
  const result = await buildWithTestSidecar({
    model: 'gpt-test',
    input: [{ type: 'message', role: 'user', content: 'hi' }],
    text: { verbosity: 'low' },
  });

  assertEquals(result.target.verbosity, 'low');
});

test.each(['system', 'developer'] as const)('preserves %s text part boundaries', async role => {
  const result = await buildWithTestSidecar({ model: 'gpt-test', input: [{ type: 'message', role, content: [{ type: 'input_text', text: 'a' }, { type: 'input_text', text: 'b' }] }] });
  assertEquals(result.target.messages, [{ role, content: [{ type: 'text', text: 'a' }, { type: 'text', text: 'b' }] }]);
});

test.each(['developer'] as const)('collapses an empty %s message to the empty string', async role => {
  const result = await buildWithTestSidecar({ model: 'gpt-test', input: [{ type: 'message', role, content: '' }] });
  assertEquals(result.target.messages, [{ role, content: '' }]);
});
