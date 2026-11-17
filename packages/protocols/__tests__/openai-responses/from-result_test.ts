import { test } from 'vitest';

import { openaiResponsesResultToEvents } from '../../src/openai-responses/from-result.ts';
import type { OpenAIResponsesOutputItemEx, OpenAIResponsesResultEx, OpenAIResponsesStreamEventEx } from '../../src/openai-responses/index.ts';
import { assertEquals, assertFalse, assertThrows } from '@floway-dev/test-utils';

const completedResponse: OpenAIResponsesResultEx = {
  id: 'resp_completed',
  object: 'response',
  model: 'gpt-test',
  status: 'completed',
  output: [
    {
      type: 'message',
      id: 'msg_completed',
      status: 'completed',
      role: 'assistant',
      content: [{ type: 'output_text', text: 'Hello', annotations: [] }],
    },
  ],
  error: null,
  incomplete_details: null,
  usage: { input_tokens: 1, output_tokens: 2, total_tokens: 3 },
};

test.each(['in_progress', 'cancelled'] as const)('openaiResponsesResultToEvents rejects nonterminal status %s', status => {
  assertThrows(
    () => Array.from(openaiResponsesResultToEvents({ ...completedResponse, status })),
    TypeError,
    `Cannot expand nonterminal OpenAI Responses status '${status}'`,
  );
});

test('openaiResponsesResultToEvents projects terminal JSON into OpenAI Responses stream events', () => {
  const frames = Array.from(openaiResponsesResultToEvents(completedResponse));

  assertEquals(
    frames.map(frame => frame.type),
    ['event', 'event', 'event', 'event', 'event', 'event', 'event', 'event', 'event'],
  );
  assertEquals(
    frames.map(frame => frame.event.type),
    [
      'response.created',
      'response.in_progress',
      'response.output_item.added',
      'response.content_part.added',
      'response.output_text.delta',
      'response.output_text.done',
      'response.content_part.done',
      'response.output_item.done',
      'response.completed',
    ],
  );
});

test('openaiResponsesResultToEvents starts JSON fallback streams with an empty in-progress snapshot', () => {
  const frames = Array.from(openaiResponsesResultToEvents(completedResponse));
  const created = frames[0].event as {
    type: 'response.created';
    sequence_number: number;
    response: OpenAIResponsesResultEx;
  };
  const completed = frames.at(-1)?.event;

  assertEquals(created.type, 'response.created');
  if (created.type !== 'response.created') throw new Error('unexpected event');
  assertEquals(created.sequence_number, 0);
  assertEquals(created.response.status, 'in_progress');
  assertEquals(created.response.output, []);
  // `output_text` is an SDK-only convenience alias absent from the
  // real wire; the start snapshot strips it. Producers that send it
  // through `result()` (which still emits the field on the terminal
  // frame) are preserved by the spread.
  assertFalse('output_text' in created.response);
  // `error` and `incomplete_details` are spec-required on every
  // Response (both nullable). The start snapshot defaults both to
  // null so typed-SDK clients that probe for the field's presence
  // (rather than its truthiness) keep working.
  assertEquals(created.response.error, null);
  assertEquals(created.response.incomplete_details, null);

  assertEquals(completed?.type, 'response.completed');
});

test('openaiResponsesResultToEvents expands refusal content with the native refusal lifecycle', () => {
  const events = Array.from(openaiResponsesResultToEvents({
    ...completedResponse,
    output: [{
      type: 'message',
      id: 'msg_refusal',
      status: 'completed',
      role: 'assistant',
      content: [{ type: 'refusal', refusal: 'Cannot help.' }],
    }],
  })).map(frame => frame.event);

  const added = events.find(event => event.type === 'response.output_item.added') as Extract<OpenAIResponsesStreamEventEx, { type: 'response.output_item.added' }>;
  assertEquals(added.item, {
    type: 'message',
    id: 'msg_refusal',
    status: 'in_progress',
    role: 'assistant',
    content: [{ type: 'refusal', refusal: '' }],
  });

  assertEquals(events.filter(event => event.type.startsWith('response.refusal')), [
    {
      type: 'response.refusal.delta',
      item_id: 'msg_refusal',
      output_index: 0,
      content_index: 0,
      delta: 'Cannot help.',
      sequence_number: 4,
    },
    {
      type: 'response.refusal.done',
      item_id: 'msg_refusal',
      output_index: 0,
      content_index: 0,
      refusal: 'Cannot help.',
      sequence_number: 5,
    },
  ]);
});

test('openaiResponsesResultToEvents preserves advanced tool item wire fields', () => {
  const output = [
    {
      type: 'computer_call',
      id: 'cu_1',
      call_id: 'call_computer',
      status: 'completed',
      actions: [{ type: 'screenshot' }],
    },
    {
      type: 'computer_call_output',
      id: 'cuo_1',
      call_id: 'call_computer',
      output: { type: 'computer_screenshot', image_url: 'data:image/png;base64,AA==' },
      status: 'completed',
    },
    {
      type: 'tool_search_call',
      id: 'tsc_1',
      call_id: 'call_search',
      arguments: { query: 'lookup', limit: 3 },
      execution: 'client',
      status: 'completed',
    },
    {
      type: 'tool_search_output',
      id: 'tso_1',
      call_id: 'call_search',
      execution: 'client',
      status: 'completed',
      tools: [
        { type: 'function', name: 'lookup', parameters: {}, strict: true },
        { type: 'file_search', vector_store_ids: ['vs_1'] },
        { type: 'computer' },
        { type: 'computer_use_preview', display_height: 768, display_width: 1024, environment: 'browser' },
        { type: 'local_shell' },
      ],
    },
    {
      type: 'code_interpreter_call',
      id: 'ci_1',
      code: 'print(1)',
      container_id: 'cntr_1',
      outputs: [{ type: 'logs', logs: '1' }],
      status: 'completed',
    },
    {
      type: 'shell_call',
      id: 'sh_1',
      call_id: 'call_shell',
      action: { commands: ['pwd'], max_output_length: 1024, timeout_ms: 1000 },
      environment: { type: 'local' },
      status: 'completed',
    },
    {
      type: 'shell_call_output',
      id: 'sho_1',
      call_id: 'call_shell',
      max_output_length: 1024,
      output: [{ stdout: '/tmp', stderr: '', outcome: { type: 'exit', exit_code: 0 } }],
      status: 'completed',
    },
    {
      type: 'apply_patch_call',
      id: 'apc_1',
      call_id: 'call_patch',
      operation: { type: 'update_file', path: 'a.ts', diff: '@@' },
      status: 'completed',
    },
    {
      type: 'apply_patch_call_output',
      id: 'apco_1',
      call_id: 'call_patch',
      status: 'completed',
      output: 'Done',
    },
    {
      type: 'mcp_call',
      id: 'mcp_1',
      arguments: '{}',
      name: 'lookup',
      server_label: 'docs',
      output: 'result',
      status: 'completed',
    },
    {
      type: 'mcp_list_tools',
      id: 'mcpl_1',
      server_label: 'docs',
      tools: [{ name: 'lookup', input_schema: {} }],
    },
    {
      type: 'mcp_approval_request',
      id: 'mcpr_1',
      arguments: '{}',
      name: 'lookup',
      server_label: 'docs',
    },
    {
      type: 'mcp_approval_response',
      id: 'mcpa_1',
      approval_request_id: 'mcpr_1',
      approve: true,
    },
  ] satisfies OpenAIResponsesOutputItemEx[];

  const frames = Array.from(openaiResponsesResultToEvents({
    ...completedResponse,
    output,
  }));
  const added = frames
    .map(frame => frame.event)
    .filter(event => event.type === 'response.output_item.added')
    .map(event => event.item);
  const done = frames
    .map(frame => frame.event)
    .filter(event => event.type === 'response.output_item.done')
    .map(event => event.item);

  assertEquals(added, output);
  assertEquals(done, output);
});

test('openaiResponsesResultToEvents surfaces a missing function_call item id instead of inventing one', () => {
  let threw = false;
  try {
    Array.from(
      openaiResponsesResultToEvents({
        ...completedResponse,
        output: [
          {
            type: 'function_call',
            call_id: 'call_1',
            name: 'do_thing',
            arguments: '{}',
            status: 'completed',
          },
        ],
      }),
    );
  } catch {
    threw = true;
  }
  assertEquals(threw, true);
});
