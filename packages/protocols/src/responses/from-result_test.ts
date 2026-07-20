import { test } from 'vitest';

import { responsesResultToEvents } from './from-result.ts';
import type { ResponsesOutputItem, ResponsesResult } from './index.ts';
import { assertEquals, assertFalse, assertThrows } from '../test-assert.ts';

const completedResponse: ResponsesResult = {
  id: 'resp_completed',
  object: 'response',
  model: 'gpt-test',
  status: 'completed',
  output_text: 'Hello',
  output: [
    {
      type: 'message',
      id: 'msg_completed',
      role: 'assistant',
      content: [{ type: 'output_text', text: 'Hello' }],
    },
  ],
  error: null,
  incomplete_details: null,
  usage: { input_tokens: 1, output_tokens: 2, total_tokens: 3 },
};

test.each(['queued', 'in_progress', 'cancelled'] as const)('responsesResultToEvents rejects nonterminal status %s', status => {
  assertThrows(
    () => Array.from(responsesResultToEvents({ ...completedResponse, status })),
    TypeError,
    `Cannot expand nonterminal Responses status '${status}'`,
  );
});

test('responsesResultToEvents projects terminal JSON into Responses stream events', () => {
  const frames = Array.from(responsesResultToEvents(completedResponse));

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

test('responsesResultToEvents starts JSON fallback streams with an empty in-progress snapshot', () => {
  const frames = Array.from(responsesResultToEvents(completedResponse));
  const created = frames[0].event as {
    type: 'response.created';
    sequence_number: number;
    response: ResponsesResult;
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

test('responsesResultToEvents keeps incomplete details only on the terminal event', () => {
  const frames = Array.from(
    responsesResultToEvents({
      ...completedResponse,
      id: 'resp_incomplete',
      status: 'incomplete',
      incomplete_details: { reason: 'max_output_tokens' },
    }),
  );

  const created = frames[0].event as {
    type: 'response.created';
    response: ResponsesResult;
  };
  const terminal = frames.at(-1)?.event as {
    type: 'response.incomplete';
    response: ResponsesResult;
  };

  // Snapshot strips terminal-only incomplete_details and defaults it
  // to null so the spec-required field is still present.
  assertEquals(created.response.incomplete_details, null);
  assertEquals(terminal.type, 'response.incomplete');
  assertEquals(terminal.response.incomplete_details?.reason, 'max_output_tokens');
});

test('responsesResultToEvents keeps failure details only on the terminal event', () => {
  const frames = Array.from(
    responsesResultToEvents({
      id: 'resp_failed',
      object: 'response',
      model: 'gpt-test',
      status: 'failed',
      output_text: '',
      output: [],
      error: {
        message: 'upstream failed',
        type: 'server_error',
        code: 'boom',
      },
      incomplete_details: null,
      usage: { input_tokens: 1, output_tokens: 0, total_tokens: 1 },
    }),
  );

  const created = frames[0].event as {
    type: 'response.created';
    response: ResponsesResult;
  };
  const terminal = frames.at(-1)?.event as {
    type: 'response.failed';
    response: ResponsesResult;
  };

  // Snapshot strips the terminal error and defaults to null so the
  // spec-required field is present on the in-progress snapshot.
  assertEquals(created.response.error, null);
  assertEquals(terminal.type, 'response.failed');
  assertEquals(terminal.response.error?.message, 'upstream failed');
});

test('responsesResultToEvents propagates the real message item id to the added item and every child frame', () => {
  const frames = Array.from(
    responsesResultToEvents({
      ...completedResponse,
      output: [
        {
          type: 'message',
          id: 'msg_real',
          role: 'assistant',
          content: [{ type: 'output_text', text: 'Hello' }],
        },
      ],
    }),
  );

  const added = frames.find(frame => frame.event.type === 'response.output_item.added')?.event as {
    item: { id?: string };
  };
  assertEquals(added.item.id, 'msg_real');

  const childItemIds = frames
    .map(frame => frame.event)
    .filter((event): event is typeof event & { item_id: string } => 'item_id' in event)
    .map(event => event.item_id);
  assertEquals(childItemIds.length, 4);
  for (const itemId of childItemIds) assertEquals(itemId, 'msg_real');
});

test('responsesResultToEvents propagates the real function_call item id to the added item and child frames', () => {
  const frames = Array.from(
    responsesResultToEvents({
      ...completedResponse,
      output: [
        {
          type: 'function_call',
          id: 'fc_real',
          call_id: 'call_1',
          name: 'do_thing',
          arguments: '{"x":1}',
          status: 'completed',
          caller: { type: 'program', caller_id: 'call_prog_1' },
        },
      ],
    }),
  );

  const added = frames.find(frame => frame.event.type === 'response.output_item.added')?.event as {
    item: { id?: string; caller?: unknown };
  };
  assertEquals(added.item.id, 'fc_real');
  assertEquals(added.item.caller, { type: 'program', caller_id: 'call_prog_1' });

  const childItemIds = frames
    .map(frame => frame.event)
    .filter((event): event is typeof event & { item_id: string } => 'item_id' in event)
    .map(event => event.item_id);
  assertEquals(childItemIds.length, 2);
  for (const itemId of childItemIds) assertEquals(itemId, 'fc_real');
});

test('responsesResultToEvents preserves advanced tool item wire fields', () => {
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
  ] satisfies ResponsesOutputItem[];

  const frames = Array.from(responsesResultToEvents({
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

test('responsesResultToEvents surfaces a missing function_call item id instead of inventing one', () => {
  let threw = false;
  try {
    Array.from(
      responsesResultToEvents({
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

test('responsesResultToEvents expands a web_search_call with the full 5-event lifecycle', () => {
  const frames = Array.from(
    responsesResultToEvents({
      id: 'resp_ws',
      object: 'response',
      model: 'gpt-test',
      status: 'completed',
      output_text: '',
      output: [
        {
          type: 'web_search_call',
          id: 'ws_1',
          status: 'completed',
          action: { type: 'search', queries: ['hello'] },
          results: [],
        },
      ],
      error: null,
      incomplete_details: null,
      usage: { input_tokens: 1, output_tokens: 1, total_tokens: 2 },
    }),
  );

  assertEquals(
    frames.map(frame => frame.event.type),
    [
      'response.created',
      'response.in_progress',
      'response.output_item.added',
      'response.web_search_call.in_progress',
      'response.web_search_call.searching',
      'response.web_search_call.completed',
      'response.output_item.done',
      'response.completed',
    ],
  );
});

test('responsesResultToEvents expands a completed image_generation_call lifecycle', () => {
  const frames = Array.from(
    responsesResultToEvents({
      id: 'resp_img',
      object: 'response',
      model: 'gpt-test',
      status: 'completed',
      output_text: '',
      output: [
        {
          type: 'image_generation_call',
          id: 'ig_1',
          status: 'completed',
          result: 'ZmFrZQ==',
          revised_prompt: 'a cube',
        },
      ],
      error: null,
      incomplete_details: null,
    }),
  );

  assertEquals(
    frames.map(frame => frame.event.type),
    [
      'response.created',
      'response.in_progress',
      'response.output_item.added',
      'response.image_generation_call.in_progress',
      'response.image_generation_call.generating',
      'response.image_generation_call.completed',
      'response.output_item.done',
      'response.completed',
    ],
  );
});

test('responsesResultToEvents omits image_generation_call completed event for failed items', () => {
  const frames = Array.from(
    responsesResultToEvents({
      id: 'resp_img_failed',
      object: 'response',
      model: 'gpt-test',
      status: 'completed',
      output_text: '',
      output: [
        {
          type: 'image_generation_call',
          id: 'ig_1',
          status: 'failed',
          error: { message: 'failed', code: 'server_error' },
        },
      ],
      error: null,
      incomplete_details: null,
    }),
  );

  assertEquals(frames.map(frame => frame.event.type).includes('response.image_generation_call.completed'), false);
});
