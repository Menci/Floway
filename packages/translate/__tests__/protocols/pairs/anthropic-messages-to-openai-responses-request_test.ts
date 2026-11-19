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

test('preserves expressible Messages metadata extensions and rejects non-string values', async () => {
  const payload = { model: 'm', max_tokens: 16, messages: [], metadata: { user_id: 'u', tenant: 't' } };
  assertEquals((await buildWithTestSidecar(payload)).metadata, { user_id: 'u', tenant: 't' });
  await assertRejects(() => buildWithTestSidecar({ ...payload, metadata: { user_id: 'u', tenant: { nested: 't' } } } as AnthropicMessagesPayload), undefined, 'tenant');
});
