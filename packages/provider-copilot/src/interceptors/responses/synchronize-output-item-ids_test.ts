import { test } from 'vitest';

import { withOutputItemIdsSynchronized } from './synchronize-output-item-ids.ts';
import type { ResponsesBoundaryCtx } from './types.ts';
import { doneFrame, eventFrame, type ProtocolFrame } from '@floway-dev/protocols/common';
import type { ResponsesPayload, ResponsesStreamEvent } from '@floway-dev/protocols/responses';
import type { ProviderResponsesResult } from '@floway-dev/provider';
import { assertEquals, stubProviderModel } from '@floway-dev/test-utils';

const stubRequest = {};

const invocation = (): ResponsesBoundaryCtx => ({
  payload: {
    model: 'test-model',
    input: [] as unknown as ResponsesPayload['input'],
    instructions: null,
    temperature: 1,
    top_p: null,
    max_output_tokens: 32,
    tools: null,
    tool_choice: 'auto',
    metadata: null,
    stream: true,
    store: false,
    parallel_tool_calls: true,
  },
  headers: new Headers(),
  model: stubProviderModel({ endpoints: { responses: {} } }),
  action: 'generate',
});

const collect = async (result: ProviderResponsesResult): Promise<ProtocolFrame<ResponsesStreamEvent>[]> => {
  if (result.action !== 'generate' || !result.ok) throw new Error('expected generate/ok result');
  const out: ProtocolFrame<ResponsesStreamEvent>[] = [];
  for await (const frame of result.events) out.push(frame);
  return out;
};

const runWith = async (frames: ProtocolFrame<ResponsesStreamEvent>[]): Promise<ProtocolFrame<ResponsesStreamEvent>[]> => {
  const result = await withOutputItemIdsSynchronized(invocation(), stubRequest, () =>
    Promise.resolve<ProviderResponsesResult>({
      action: 'generate',
      ok: true,
      events: (async function* () {
        for (const frame of frames) yield frame;
      })(),
      modelKey: 'test-model-key',
    }));
  return await collect(result);
};

const itemEvent = (id: string | undefined, outputIndex: number, kind: 'added' | 'done'): ResponsesStreamEvent =>
  ({
    type: kind === 'added' ? 'response.output_item.added' : 'response.output_item.done',
    output_index: outputIndex,
    item: id === undefined ? { type: 'message' } : { id, type: 'message' },
  }) as ResponsesStreamEvent;

const itemIdOf = (frame: ProtocolFrame<ResponsesStreamEvent>): string | undefined => {
  if (frame.type !== 'event') throw new Error('expected event frame');
  const event = frame.event as { item?: { id?: string }; item_id?: string };
  return event.item?.id ?? event.item_id;
};

test('rewrites a divergent .done id back to the id pinned on .added', async () => {
  const out = await runWith([
    eventFrame(itemEvent('upstream-added-1', 0, 'added')),
    eventFrame(itemEvent('upstream-done-1', 0, 'done')),
    doneFrame(),
  ]);

  assertEquals(itemIdOf(out[0]), 'upstream-added-1');
  assertEquals(itemIdOf(out[1]), 'upstream-added-1');
  assertEquals(out[2], doneFrame());
});

test('synthesizes a stable oi_<output_index>_<suffix> id when .added omits item.id', async () => {
  const out = await runWith([
    eventFrame(itemEvent(undefined, 3, 'added')),
    eventFrame(itemEvent('upstream-done-arbitrary', 3, 'done')),
    eventFrame(({ type: 'response.output_text.delta', item_id: 'upstream-mid', output_index: 3, content_index: 0, delta: 'hi' }) as ResponsesStreamEvent),
    doneFrame(),
  ]);

  const synthesized = itemIdOf(out[0]);
  if (!synthesized) throw new Error('expected synthesized id');
  assertEquals(synthesized.startsWith('oi_3_'), true);
  assertEquals(synthesized.length, 'oi_3_'.length + 16);

  // Every later event in the same output_index must adopt the pinned id.
  assertEquals(itemIdOf(out[1]), synthesized);
  assertEquals(itemIdOf(out[2]), synthesized);
});

test('rewrites item_id on mid-item delta events by output_index', async () => {
  const out = await runWith([
    eventFrame(itemEvent('pinned-A', 0, 'added')),
    eventFrame(({ type: 'response.content_part.added', item_id: 'drift-A', output_index: 0, content_index: 0, part: { type: 'output_text', text: '' } }) as ResponsesStreamEvent),
    eventFrame(({ type: 'response.output_text.delta', item_id: 'drift-A', output_index: 0, content_index: 0, delta: 'hello' }) as ResponsesStreamEvent),
    eventFrame(({ type: 'response.function_call_arguments.delta', item_id: 'drift-A', output_index: 0, delta: '{"k":' }) as ResponsesStreamEvent),
    eventFrame(itemEvent('drift-A', 0, 'done')),
    doneFrame(),
  ]);

  for (const frame of out.slice(0, 5)) {
    assertEquals(itemIdOf(frame), 'pinned-A');
  }
});

test('tracks pinned ids per output_index independently', async () => {
  const out = await runWith([
    eventFrame(itemEvent('pinned-0', 0, 'added')),
    eventFrame(itemEvent('pinned-1', 1, 'added')),
    eventFrame(({ type: 'response.output_text.delta', item_id: 'drift-1', output_index: 1, content_index: 0, delta: 'a' }) as ResponsesStreamEvent),
    eventFrame(({ type: 'response.output_text.delta', item_id: 'drift-0', output_index: 0, content_index: 0, delta: 'b' }) as ResponsesStreamEvent),
    doneFrame(),
  ]);

  assertEquals(itemIdOf(out[0]), 'pinned-0');
  assertEquals(itemIdOf(out[1]), 'pinned-1');
  assertEquals(itemIdOf(out[2]), 'pinned-1');
  assertEquals(itemIdOf(out[3]), 'pinned-0');
});

test('leaves events without a tracked output_index unchanged', async () => {
  // A delta arrives before any .added pinned an id — the tracker has nothing
  // for output_index 7, so we MUST NOT invent one.
  const out = await runWith([
    eventFrame(({ type: 'response.output_text.delta', item_id: 'untracked', output_index: 7, content_index: 0, delta: 'x' }) as ResponsesStreamEvent),
    doneFrame(),
  ]);

  assertEquals(itemIdOf(out[0]), 'untracked');
});
