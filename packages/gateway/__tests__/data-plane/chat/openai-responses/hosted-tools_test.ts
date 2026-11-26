import { expect, test } from 'vitest';

import { SHIM_TOOL_NAME } from '../../../../src/data-plane/chat/openai-responses/hosted-tools/web-search.ts';
import { consumeTurnStreaming, createMergeState, type InterceptedFunctionCall, type ServerToolResultSlot, type TurnSummary } from '../../../../src/data-plane/chat/openai-responses/hosted-tools.ts';
import { eventFrame, type ProtocolFrame } from '@floway-dev/protocols/common';
import type { OpenAIResponsesResultEx, OpenAIResponsesStreamEventEx } from '@floway-dev/protocols/openai-responses';
import { assert, assertEquals, assertFalse } from '@floway-dev/test-utils';

const emptyResult = (id: string, status: OpenAIResponsesResultEx['status']): OpenAIResponsesResultEx => ({
  id,
  object: 'response',
  model: 'test-model',
  output: [],
  status,
  error: null,
  incomplete_details: null,
});

const mkResponseCreated = (responseId = 'upstream_test'): ProtocolFrame<OpenAIResponsesStreamEventEx> =>
  eventFrame({
    type: 'response.created',
    response: emptyResult(responseId, 'in_progress'),
  });

const mkResponseQueued = (responseId = 'upstream_test'): ProtocolFrame<OpenAIResponsesStreamEventEx> =>
  eventFrame({
    type: 'response.queued',
    response: emptyResult(responseId, 'queued'),
  });

const mkResponseInProgress = (responseId = 'upstream_test'): ProtocolFrame<OpenAIResponsesStreamEventEx> =>
  eventFrame({
    type: 'response.in_progress',
    response: emptyResult(responseId, 'in_progress'),
  });

const mkFunctionCallAdded = (outputIndex: number, callId: string, name: string): ProtocolFrame<OpenAIResponsesStreamEventEx> =>
  eventFrame({
    type: 'response.output_item.added',
    output_index: outputIndex,
    item: {
      type: 'function_call',
      call_id: callId,
      name,
      arguments: '',
      status: 'in_progress',
    },
  });

const mkFunctionCallArgsDone = (outputIndex: number, args: string, itemId = `fc_${outputIndex}`): ProtocolFrame<OpenAIResponsesStreamEventEx> =>
  eventFrame({
    type: 'response.function_call_arguments.done',
    item_id: itemId,
    output_index: outputIndex,
    arguments: args,
  });

const mkFunctionCallDone = (outputIndex: number, callId: string, name: string, args: string): ProtocolFrame<OpenAIResponsesStreamEventEx> =>
  eventFrame({
    type: 'response.output_item.done',
    output_index: outputIndex,
    item: {
      type: 'function_call',
      call_id: callId,
      name,
      arguments: args,
      status: 'completed',
    },
  });

const mkMessageAdded = (outputIndex: number, itemId = `msg_${outputIndex}`): ProtocolFrame<OpenAIResponsesStreamEventEx> =>
  eventFrame({
    type: 'response.output_item.added',
    output_index: outputIndex,
    item: {
      type: 'message',
      id: itemId,
      status: 'in_progress',
      role: 'assistant',
      content: [{ type: 'output_text', text: '', annotations: [] }],
    },
  });

const mkMessageDone = (outputIndex: number, text: string, itemId = `msg_${outputIndex}`): ProtocolFrame<OpenAIResponsesStreamEventEx> =>
  eventFrame({
    type: 'response.output_item.done',
    output_index: outputIndex,
    item: {
      type: 'message',
      id: itemId,
      status: 'completed',
      role: 'assistant',
      content: [{ type: 'output_text', text, annotations: [] }],
    },
  });

const mkResponseCompleted = (
  usage?: OpenAIResponsesResultEx['usage'],
  responseId = 'upstream_test',
): ProtocolFrame<OpenAIResponsesStreamEventEx> =>
  eventFrame<OpenAIResponsesStreamEventEx>({
    type: 'response.completed',
    response: {
      ...emptyResult(responseId, 'completed'),
      ...(usage !== undefined ? { usage } : {}),
    },
  });

const outputItemDoneEvents = (frames: ProtocolFrame<OpenAIResponsesStreamEventEx>[]): Array<Extract<OpenAIResponsesStreamEventEx, { type: 'response.output_item.done' }>> =>
  frames.flatMap(frame => frame.type === 'event' ? [frame.event] : [])
    .filter((e): e is Extract<OpenAIResponsesStreamEventEx, { type: 'response.output_item.done' }> => e.type === 'response.output_item.done');

// ── Activation gating ──────────────────────────────────────────────────

const mkFunctionCallArgsDelta = (outputIndex: number, delta: string, itemId = `fc_${outputIndex}`): ProtocolFrame<OpenAIResponsesStreamEventEx> =>
  eventFrame({
    type: 'response.function_call_arguments.delta',
    item_id: itemId,
    output_index: outputIndex,
    delta,
  });

const framesOf = (...frames: ProtocolFrame<OpenAIResponsesStreamEventEx>[]): AsyncIterable<ProtocolFrame<OpenAIResponsesStreamEventEx>> => (async function* () {
  yield* frames;
})();

const eventTypesOf = (frames: ProtocolFrame<OpenAIResponsesStreamEventEx>[]): string[] =>
  frames.flatMap(f => (f.type === 'event' ? [f.event.type] : []));

interface DispatchRecord {
  intercepted: InterceptedFunctionCall;
}

// Records every shim call without producing IRs or start frames.
// Tests that care about dispatcher behavior pass a custom dispatcher.
const recordingDispatcher = (records: DispatchRecord[]) => ({ intercepted }: { intercepted: InterceptedFunctionCall }) => {
  records.push({ intercepted });
  return [] as ServerToolResultSlot[];
};

type DrainResult = {
  downstreamFrames: ProtocolFrame<OpenAIResponsesStreamEventEx>[];
  summary: TurnSummary;
  records: DispatchRecord[];
};

const drain = async (
  iter: AsyncGenerator<ProtocolFrame<OpenAIResponsesStreamEventEx>, TurnSummary>,
  records: DispatchRecord[],
): Promise<DrainResult> => {
  const downstreamFrames: ProtocolFrame<OpenAIResponsesStreamEventEx>[] = [];
  let summary: TurnSummary | undefined;
  while (true) {
    const next = await iter.next();
    if (next.done) {
      summary = next.value;
      break;
    }
    downstreamFrames.push(next.value);
  }
  return { downstreamFrames, summary: summary!, records };
};

const loopState = () => ({ iterationCount: 1, remainingToolCalls: undefined });

const consumeTurn = async (
  frames: AsyncIterable<ProtocolFrame<OpenAIResponsesStreamEventEx>>,
  state: Parameters<typeof consumeTurnStreaming>[1],
  isFirstTurn: boolean,
): Promise<DrainResult> => {
  const records: DispatchRecord[] = [];
  return await drain(
    consumeTurnStreaming(frames, state, isFirstTurn, new Map([[SHIM_TOOL_NAME, recordingDispatcher(records)]]), loopState(), []),
    records,
  );
};

test('consumeTurn uses the completed call namespace before executing a hosted tool', async () => {
  const completed = {
    type: 'function_call' as const,
    id: 'fc_client', call_id: 'call_client', namespace: 'client', name: SHIM_TOOL_NAME,
    arguments: '{"client":true}', status: 'completed',
  };
  const { namespace: _namespace, ...completedWithoutNamespace } = completed;
  const result = await consumeTurn(framesOf(
    mkResponseCreated(),
    eventFrame<OpenAIResponsesStreamEventEx>({
      type: 'response.output_item.added', output_index: 0,
      item: { ...completedWithoutNamespace, arguments: '', status: 'in_progress' },
    }),
    mkFunctionCallArgsDelta(0, completed.arguments, completed.id),
    mkFunctionCallArgsDone(0, completed.arguments, completed.id),
    eventFrame<OpenAIResponsesStreamEventEx>({ type: 'response.output_item.done', output_index: 0, item: completed }),
    mkResponseCompleted(),
  ), createMergeState(), true);

  assertEquals(result.records, []);
  assertEquals(result.summary.dispatchedSlots, []);
  assertFalse(result.summary.sawServerToolCall);
  assertEquals(result.summary.sawClientToolCall, true);
  assertEquals(outputItemDoneEvents(result.downstreamFrames).map(event => event.item), [completed]);
  assertEquals(eventTypesOf(result.downstreamFrames).filter(type => type.startsWith('response.function_call_arguments.')), [
    'response.function_call_arguments.delta', 'response.function_call_arguments.done',
  ]);
});

test('a namespaced call using a hosted tool leaf name cannot buffer unbounded arguments', async () => {
  const source = async function* () {
    yield mkResponseCreated();
    yield eventFrame<OpenAIResponsesStreamEventEx>({
      type: 'response.output_item.added', output_index: 0,
      item: { type: 'function_call', id: 'fc_client', call_id: 'call_client', namespace: 'client', name: SHIM_TOOL_NAME, arguments: '', status: 'in_progress' },
    });
    const chunk = 'x'.repeat(1024 * 1024);
    for (let index = 0; index <= 64; index++) yield mkFunctionCallArgsDelta(0, chunk, 'fc_client');
  };
  await expect(consumeTurn(source(), createMergeState(), true)).rejects.toThrow(/hosted tool buffer exceeds/);
});

test('completed calls remain charged while their hosted slots wait for materialization', async () => {
  const args = JSON.stringify({ query: 'x'.repeat(1024 * 1024) });
  let closed = 0;
  let accepted = 0;
  const source = async function* () {
    yield mkResponseCreated();
    for (let index = 0; index <= 64; index++) {
      const identity = { type: 'function_call' as const, id: `fc_${index}`, call_id: `call_${index}`, name: SHIM_TOOL_NAME };
      yield eventFrame<OpenAIResponsesStreamEventEx>({
        type: 'response.output_item.added', output_index: index,
        item: { ...identity, namespace: 'client', arguments: '', status: 'in_progress' },
      });
      closed++;
      yield eventFrame<OpenAIResponsesStreamEventEx>({
        type: 'response.output_item.done', output_index: index, item: { ...identity, arguments: args, status: 'completed' },
      });
    }
    yield mkResponseCompleted();
  };
  const dispatchers = new Map([[SHIM_TOOL_NAME, () => {
    accepted++;
    return [{
      id: `search_${accepted}`, startItem: { type: 'web_search_call' }, startEvents: [],
      async *run(): AsyncGenerator<never, never> { throw new Error('Expected overflow before starting a search'); },
    }];
  }]]);
  const run = consumeTurnStreaming(source(), createMergeState(), true, dispatchers, loopState(), []);
  await expect(drain(run, [])).rejects.toThrow(/hosted tool buffer exceeds/);
  expect(accepted).toBeGreaterThan(1);
  expect(closed).toBeLessThan(65);
});

test('consumeTurn forwards queued only from the first upstream turn', async () => {
  const firstState = createMergeState();
  const first = await consumeTurn(
    framesOf(mkResponseQueued('queued_first'), mkResponseCreated('created_first'), mkResponseCompleted()),
    firstState,
    true,
  );
  assertEquals(eventTypesOf(first.downstreamFrames), ['response.queued', 'response.created']);
  const queued = first.downstreamFrames[0];
  assert(queued.type === 'event' && queued.event.type === 'response.queued');
  assertEquals(queued.event.response.id, firstState.synthesizedResponseId);
  assertEquals(queued.event.response.status, 'queued');

  const later = await consumeTurn(
    framesOf(mkResponseQueued('queued_later'), mkResponseCreated('created_later'), mkResponseCompleted()),
    createMergeState(),
    false,
  );
  assertEquals(later.downstreamFrames, []);
});

test('consumeTurn forwards content_part / output_text / annotation events live with rewritten item_id', async () => {
  const state = createMergeState();
  const result = await consumeTurn(
    framesOf(
      mkResponseCreated(),
      mkResponseInProgress(),
      mkMessageAdded(0, 'msg_upstream'),
      eventFrame<OpenAIResponsesStreamEventEx>({
        type: 'response.content_part.added',
        item_id: 'msg_upstream',
        output_index: 0,
        content_index: 0,
        part: { type: 'output_text', text: '', annotations: [] },
      }),
      eventFrame<OpenAIResponsesStreamEventEx>({
        type: 'response.output_text.delta',
        item_id: 'msg_upstream',
        output_index: 0,
        content_index: 0,
        delta: 'hello ',
      }),
      eventFrame<OpenAIResponsesStreamEventEx>({
        type: 'response.output_text.annotation.added',
        item_id: 'msg_upstream',
        output_index: 0,
        content_index: 0,
        annotation_index: 0,
        annotation: {
          type: 'url_citation',
          url: 'https://x',
          title: 'X',
          start_index: 0,
          end_index: 5,
        },
      }),
      eventFrame<OpenAIResponsesStreamEventEx>({
        type: 'response.output_text.done',
        item_id: 'msg_upstream',
        output_index: 0,
        content_index: 0,
        text: 'hello world',
      }),
      eventFrame<OpenAIResponsesStreamEventEx>({
        type: 'response.content_part.done',
        item_id: 'msg_upstream',
        output_index: 0,
        content_index: 0,
        part: { type: 'output_text', text: 'hello world', annotations: [] },
      }),
      mkMessageDone(0, 'hello world', 'msg_upstream'),
      mkResponseCompleted(),
    ),
    state,
    true,
  );

  assertEquals(result.records.length, 0);
  assertEquals(eventTypesOf(result.downstreamFrames), [
    'response.created',
    'response.in_progress',
    'response.output_item.added',
    'response.content_part.added',
    'response.output_text.delta',
    'response.output_text.annotation.added',
    'response.output_text.done',
    'response.content_part.done',
    'response.output_item.done',
  ]);

  const addedFrame = result.downstreamFrames.find(frame =>
    frame.type === 'event' && frame.event.type === 'response.output_item.added');
  assert(addedFrame?.type === 'event');
  const messageId = (addedFrame.event as { item: { id?: string } }).item.id;
  assertEquals(messageId, 'msg_upstream');

  for (const f of result.downstreamFrames) {
    if (f.type !== 'event') continue;
    const ev = f.event as { item_id?: string };
    if (ev.item_id !== undefined) {
      assertEquals(ev.item_id, messageId);
    }
  }
});

test('consumeTurn swallows future indexed events attached to an intercepted server tool call', async () => {
  const state = createMergeState();
  const result = await consumeTurn(
    framesOf(
      mkResponseCreated(),
      mkFunctionCallAdded(0, 'cc_1', SHIM_TOOL_NAME),
      eventFrame<OpenAIResponsesStreamEventEx>({
        type: 'response.future_function_call_arguments.delta',
        item_id: 'fc_hidden',
        output_index: 0,
        delta: 'hidden',
      } as unknown as OpenAIResponsesStreamEventEx),
      mkFunctionCallDone(0, 'cc_1', SHIM_TOOL_NAME, '{"search_query":[{"q":"q"}]}'),
      mkResponseCompleted(),
    ),
    state,
    true,
  );

  assertFalse(result.downstreamFrames.some(f =>
    f.type === 'event' && (f.event as { type: string }).type === 'response.future_function_call_arguments.delta'));
});
