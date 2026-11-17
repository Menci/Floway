import { test } from 'vitest';

import { buildTargetPayloadFor, pairs } from '../../composition/helpers.ts';
import { createTestSidecarCodec } from '../../round-trip/sidecar-codec.ts';
import type { AnthropicMessagesPayload } from '@floway-dev/protocols/anthropic-messages';
import { assertEquals, assertRejects } from '@floway-dev/test-utils';

const buildWithTestSidecar = (payload: AnthropicMessagesPayload) =>
  buildTargetPayloadFor(pairs.messagesToResponses[0], pairs.messagesToResponses[1], { ...payload, stream: true }, { sidecarCodec: createTestSidecarCodec() });

test('server tool errors become incomplete Responses results', async () => {
  const result = await buildWithTestSidecar({
    model: 'm', max_tokens: 32, messages: [{
      role: 'assistant', content: [
        { type: 'server_tool_use', id: 's', name: 'web_search', input: {} },
        { type: 'web_search_tool_result', tool_use_id: 's', content: { type: 'web_search_tool_result_error', error_code: 'too_many_requests' } },
      ],
    }],
  });
  const output = result.input.find(item => item.type === 'function_call_output');
  assertEquals(output?.type === 'function_call_output' ? output.status : undefined, 'incomplete');
});

test('mixed tool-result blocks keep documents formal and unknown blocks opaque', async () => {
  const unknown = { type: 'tool_reference' as const, tool_name: 'read' };
  const result = await buildWithTestSidecar({
    model: 'm', max_tokens: 32, messages: [
      { role: 'assistant', content: [{ type: 'tool_use', id: 'c', name: 'read', input: {} }] },
      {
        role: 'user',
        content: [{
          type: 'tool_result', tool_use_id: 'c', content: [
            { type: 'document', source: { type: 'content', content: [{ type: 'text', text: 'hel' }, { type: 'text', text: 'lo' }] } },
            unknown,
          ],
        }],
      },
    ],
  });
  const output = result.input.find(item => item.type === 'function_call_output');
  assertEquals(output?.type === 'function_call_output' ? output.output : undefined, [
    { type: 'input_text', text: '<document>' },
    { type: 'input_text', text: 'hel' },
    { type: 'input_text', text: 'lo' },
    { type: 'input_text', text: '</document>' },
    { type: 'input_text', text: JSON.stringify(unknown) },
  ]);
});

test.each([
  ['text blocks', [{ type: 'text' as const, text: 'hel' }, { type: 'text' as const, text: 'lo' }], [
    { type: 'input_text' as const, text: 'hel' }, { type: 'input_text' as const, text: 'lo' },
  ]],
  ['empty text blocks', [], []],
] as const)('inline content document %s retains its nested parts', async (_name, content, expected) => {
  const result = await buildWithTestSidecar({
    model: 'm', max_tokens: 32, messages: [{
      role: 'user', content: [{ type: 'document', source: { type: 'content', content: typeof content === 'string' ? content : [...content] } }],
    }],
  });
  assertEquals(result.input, [{
    type: 'message', role: 'user', content: [
      { type: 'input_text', text: '<document>' },
      ...expected,
      { type: 'input_text', text: '</document>' },
    ],
  }]);
});

test('projects document metadata and cache breakpoints while dropping unsupported citation controls', async () => {
  const result = await buildWithTestSidecar({
    model: 'm', max_tokens: 32, messages: [{
      role: 'user', content: [{
        type: 'document', title: 'Report <1>', context: 'A & B',
        citations: { enabled: true }, cache_control: { type: 'ephemeral', ttl: '1h' },
        source: {
          type: 'content', content: [
            { type: 'text', text: 'caption', cache_control: { type: 'ephemeral', ttl: '5m' } },
            { type: 'image', source: { type: 'base64', media_type: 'image/png', data: 'AAAA' }, cache_control: null },
          ],
        },
      }],
    }],
  });
  assertEquals(result.input, [{
    type: 'message', role: 'user', content: [
      { type: 'input_text', text: '<document>\n<title>Report &lt;1&gt;</title>\n<context>A &amp; B</context>' },
      { type: 'input_text', text: 'caption', prompt_cache_breakpoint: { mode: 'explicit' } },
      { type: 'input_image', image_url: 'data:image/png;base64,AAAA', prompt_cache_breakpoint: null },
      { type: 'input_text', text: '</document>', prompt_cache_breakpoint: { mode: 'explicit' } },
    ],
  }]);
});

test('keeps search result runs between the text and images around them', async () => {
  const first = { type: 'search_result' as const, source: 'https://example.com/1', title: 'First', content: [{ type: 'text' as const, text: 'one' }] };
  const second = { ...first, source: 'https://example.com/2', title: 'Second' };
  const third = { ...first, source: 'https://example.com/3', title: 'Third' };
  const result = await buildWithTestSidecar({
    model: 'model', max_tokens: 32, messages: [
      { role: 'assistant', content: [{ type: 'tool_use', id: 'c', name: 'lookup', input: {} }] },
      {
        role: 'user', content: [{
          type: 'tool_result', tool_use_id: 'c', content: [
            { type: 'text', text: 'Before' }, first, second,
            { type: 'image', source: { type: 'base64', media_type: 'image/png', data: 'AAAA' } },
            third, { type: 'text', text: 'After' },
          ],
        }],
      },
    ],
  });
  assertEquals(result.input[1], {
    type: 'function_call_output', call_id: 'c', status: 'completed', output: [
      { type: 'input_text', text: 'Before' },
      { type: 'input_text', text: JSON.stringify([first, second]) },
      { type: 'input_image', image_url: 'data:image/png;base64,AAAA' },
      { type: 'input_text', text: JSON.stringify([third]) },
      { type: 'input_text', text: 'After' },
    ],
  });
});

test('buildTargetPayload pairs each server tool round with its own result', async () => {
  const search = (id: string, query: string) => [
    { caller: { type: 'direct' as const }, type: 'server_tool_use' as const, id, name: 'web_search' as const, input: { query } },
    {
      type: 'web_search_tool_result' as const,
      tool_use_id: id,
      content: [{ type: 'web_search_result' as const, url: `https://example.com/${id}`, title: id, encrypted_content: `enc-${id}` }],
    },
  ];
  const result = await buildWithTestSidecar({
    model: 'gpt-test',
    max_tokens: 256,
    messages: [
      {
        role: 'assistant',
        content: [
          { type: 'text', text: 'First search.' },
          ...search('st_1', 'a'),
          { type: 'text', text: 'Refining.' },
          ...search('st_2', 'b'),
          { type: 'text', text: 'Final answer.' },
        ],
      },
    ],
  });

  // Each round is a call and its own result, in the order the source stated
  // them: the text that follows a result belongs to the next round, not to the
  // end of the message.
  assertEquals(result.input, [
    { type: 'message', role: 'assistant', content: [{ type: 'output_text', text: 'First search.' }] },
    { type: 'function_call', call_id: 'st_1', name: 'web_search', arguments: '{"query":"a"}', status: 'completed' },
    {
      type: 'function_call_output',
      call_id: 'st_1',
      output: '[{"type":"web_search_result","url":"https://example.com/st_1","title":"st_1","encrypted_content":"enc-st_1"}]',
      status: 'completed',
    },
    { type: 'message', role: 'assistant', content: [{ type: 'output_text', text: 'Refining.' }] },
    { type: 'function_call', call_id: 'st_2', name: 'web_search', arguments: '{"query":"b"}', status: 'completed' },
    {
      type: 'function_call_output',
      call_id: 'st_2',
      output: '[{"type":"web_search_result","url":"https://example.com/st_2","title":"st_2","encrypted_content":"enc-st_2"}]',
      status: 'completed',
    },
    { type: 'message', role: 'assistant', content: [{ type: 'output_text', text: 'Final answer.' }] },
  ]);
});

test('buildTargetPayload projects thinking.enabled budgets onto reasoning.effort', async () => {
  for (const [budget, effort] of [[1024, 'low'], [16384, 'high']] as const) {
    const result = await buildWithTestSidecar({
      model: 'gpt-test',
      max_tokens: 4096,
      thinking: { type: 'enabled', budget_tokens: budget },
      messages: [{ role: 'user', content: 'hi' }],
    });

    assertEquals(result.reasoning, { effort });
  }
});

test('buildTargetPayload writes multi-block top-level system through Responses instructions', async () => {
  const result = await buildWithTestSidecar({
    model: 'gpt-test',
    max_tokens: 256,
    system: [
      { type: 'text', text: 'Alpha' },
      { type: 'text', text: 'Beta' },
    ],
    messages: [{ role: 'user', content: 'hi' }],
  });

  assertEquals(result.instructions, 'AlphaBeta');
  assertEquals(result.input, [{ type: 'message', role: 'user', content: 'hi' }]);
});

// OpenAI strict-mode JSON Schema validators reject {type: 'object'} without a
// `properties` field. Anthropic accepts that shape, so the input_schema must
// be normalized before forwarding to OpenAI Responses. Ref:
// https://github.com/caozhiyuan/copilot-api/commit/ad57069826843c5d17d7b0e5ef2f75050128893c
test('buildTargetPayload defaults missing input_schema.properties to {} for object tools', async () => {
  const result = await buildWithTestSidecar({
    model: 'gpt-test',
    max_tokens: 256,
    tools: [{ name: 'no_args', input_schema: { type: 'object' } }],
    messages: [{ role: 'user', content: 'hi' }],
  });

  assertEquals(result.tools, [
    {
      type: 'function',
      name: 'no_args',
      parameters: { type: 'object', properties: {} },
      strict: false,
    },
  ]);
});

test('buildTargetPayload wraps output_config.format json_schema as text.format with synthesised name and strict', async () => {
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

  assertEquals(result.text, {
    format: { type: 'json_schema', name: 'messages_response', strict: true, schema },
  });
});

test('buildTargetPayload keeps in-array system messages in place', async () => {
  const result = await buildWithTestSidecar({
    model: 'gpt-test',
    max_tokens: 256,
    messages: [
      { role: 'system', content: 'mid-array A' },
      { role: 'user', content: 'q1' },
      { role: 'assistant', content: 'a1' },
      { role: 'system', content: 'mid-array B' },
      { role: 'user', content: 'q2' },
    ],
  });

  assertEquals(result.instructions, undefined);
  const input = result.input as Array<{ type: string; role?: string }>;
  assertEquals(input.length, 5);
  assertEquals(input[0].role, 'system');
  assertEquals(input[1].role, 'user');
  assertEquals(input[2].role, 'assistant');
  assertEquals(input[3].role, 'system');
  assertEquals(input[4].role, 'user');
});

test('preserves expressible Messages metadata extensions and rejects non-string values', async () => {
  const payload = { model: 'm', max_tokens: 16, messages: [], metadata: { user_id: 'u', tenant: 't' } };
  assertEquals((await buildWithTestSidecar(payload)).metadata, { user_id: 'u', tenant: 't' });
  await assertRejects(() => buildWithTestSidecar({ ...payload, metadata: { user_id: 'u', tenant: { nested: 't' } } } as AnthropicMessagesPayload), undefined, "metadata field 'tenant'");
});

test.each([false])('maps disable_parallel_tool_use %s without changing declarations', async disabled => {
  const result = await buildWithTestSidecar({
    model: 'm', max_tokens: 32, messages: [],
    tools: [{ name: 'f', input_schema: { type: 'object', properties: {} } }],
    tool_choice: { type: 'auto', disable_parallel_tool_use: disabled },
  });
  assertEquals(result.parallel_tool_calls, !disabled);
  assertEquals(result.tools?.length, 1);
});
