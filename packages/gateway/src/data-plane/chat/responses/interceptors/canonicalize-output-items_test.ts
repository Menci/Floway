import { test } from 'vitest';

import { withResponsesOutputItemsCanonicalized } from './canonicalize-output-items.ts';
import type { ResponsesInvocation } from './types.ts';
import type { ChatGatewayCtx } from '../../shared/gateway-ctx.ts';
import { createNonResponsesSourceStore } from '../items/store.ts';
import { eventFrame, type ProtocolFrame } from '@floway-dev/protocols/common';
import type { ResponsesStreamEvent } from '@floway-dev/protocols/responses';
import { type ExecuteResult, eventResult } from '@floway-dev/provider';
import { stubModelCandidate, testTelemetryModelIdentity, assertEquals } from '@floway-dev/test-utils';
import type { CanonicalResponsesPayload } from '@floway-dev/translate/via-responses/responses-items';

const stubCtx: ChatGatewayCtx = {
  apiKeyId: 'test-key',
  upstreamIds: null,
  wantsStream: false,
  runtimeLocation: 'TEST',
  currentColo: 'TEST',
  dump: null,
  backgroundScheduler: () => {},
  requestStartedAt: 0,
  responseHeaders: new Headers(),
  store: createNonResponsesSourceStore('test-key'),
};

const invocation = (): ResponsesInvocation => ({
  payload: { model: 'gpt-test', input: [{ type: 'message' as const, role: 'user' as const, content: 'hi' }] } as CanonicalResponsesPayload,
  action: 'generate',
  candidate: stubModelCandidate(),
  targetApi: 'responses',
  headers: new Headers(),
});

interface DoneEntry {
  readonly outputIndex: number;
  readonly id: string;
  readonly encryptedContent: string | null;
  readonly type?: string;
}

interface CompletedItem {
  readonly id: string;
  readonly encryptedContent: string | null;
  readonly type?: string;
}

const runStream = (done: readonly DoneEntry[], completed: readonly CompletedItem[]) =>
  (): Promise<ExecuteResult<ProtocolFrame<ResponsesStreamEvent>>> =>
    Promise.resolve(eventResult(
      (async function* () {
        for (const entry of done) {
          const item = entry.encryptedContent === null
            ? { type: (entry.type ?? 'reasoning') as 'reasoning', id: entry.id, summary: [] }
            : { type: (entry.type ?? 'reasoning') as 'reasoning', id: entry.id, summary: [], encrypted_content: entry.encryptedContent };
          yield eventFrame({ type: 'response.output_item.done' as const, output_index: entry.outputIndex, item });
        }
        yield eventFrame({
          type: 'response.completed' as const,
          response: {
            id: 'resp_1',
            object: 'response' as const,
            model: 'gpt-test',
            status: 'completed' as const,
            output: completed.map(item => (
              item.encryptedContent === null
                ? { type: (item.type ?? 'reasoning') as 'reasoning', id: item.id, summary: [] }
                : { type: (item.type ?? 'reasoning') as 'reasoning', id: item.id, summary: [], encrypted_content: item.encryptedContent }
            )) as never,
            output_text: '',
            error: null,
            incomplete_details: null,
          },
        });
      })(),
      testTelemetryModelIdentity,
    ));

const collect = async (events: AsyncIterable<ProtocolFrame<ResponsesStreamEvent>>) => {
  const out: ResponsesStreamEvent[] = [];
  for await (const frame of events) if (frame.type === 'event') out.push(frame.event);
  return out;
};

const completedItems = (events: readonly ResponsesStreamEvent[]) => {
  const completed = events.find(event => event.type === 'response.completed');
  if (completed?.type !== 'response.completed') throw new Error('expected response.completed');
  return completed.response.output.map(item => [item.id, (item as { encrypted_content?: string }).encrypted_content] as const);
};

// Azure shape: stable id, content drifts every serialization. The terminal
// envelope's encrypted_content must be rewritten to the done-frame blob; id
// is already the same.
test('Azure shape: rewrites encrypted_content while id is stable', async () => {
  const res = await withResponsesOutputItemsCanonicalized(invocation(), stubCtx, runStream(
    [{ outputIndex: 0, id: 'rs_alpha', encryptedContent: 'ENC_DONE' }],
    [{ id: 'rs_alpha', encryptedContent: 'ENC_COMPLETED' }],
  ));
  if (res.type !== 'events') throw new Error('expected events');
  assertEquals(completedItems(await collect(res.events)), [['rs_alpha', 'ENC_DONE']]);
});

// Copilot shape: BOTH the id and the encrypted_content are re-encrypted on
// every frame. Position (output_index) is the only stable key, so both
// fields are rewritten from the done-frame entry at the same index.
test('Copilot shape: rewrites both id and encrypted_content by output_index', async () => {
  const res = await withResponsesOutputItemsCanonicalized(invocation(), stubCtx, runStream(
    [{ outputIndex: 0, id: 'b/jh+...DONE', encryptedContent: 'ENC_DONE' }],
    [{ id: 'lqVI...COMPLETED', encryptedContent: 'ENC_COMPLETED' }],
  ));
  if (res.type !== 'events') throw new Error('expected events');
  assertEquals(completedItems(await collect(res.events)), [['b/jh+...DONE', 'ENC_DONE']]);
});

// No drift: the upstream emitted identical id and encrypted_content on both
// views. Canonicalization is still applied but the rewrite is a no-op.
test('clean upstream: no-op when both views agree', async () => {
  const res = await withResponsesOutputItemsCanonicalized(invocation(), stubCtx, runStream(
    [{ outputIndex: 0, id: 'rs_alpha', encryptedContent: 'ENC_SAME' }],
    [{ id: 'rs_alpha', encryptedContent: 'ENC_SAME' }],
  ));
  if (res.type !== 'events') throw new Error('expected events');
  assertEquals(completedItems(await collect(res.events)), [['rs_alpha', 'ENC_SAME']]);
});

// Two items at indices 0 and 1, each with its own drift pattern. The map
// must look up by output_index so each item picks up its own done-frame
// view, never crossing the indices.
test('multiple items: each canonicalized by its output_index', async () => {
  const res = await withResponsesOutputItemsCanonicalized(invocation(), stubCtx, runStream(
    [
      { outputIndex: 0, id: 'done_id_0', encryptedContent: 'ENC_DONE_0' },
      { outputIndex: 1, id: 'rs_stable', encryptedContent: 'ENC_DONE_1' },
    ],
    [
      { id: 'completed_id_0', encryptedContent: 'ENC_COMPLETED_0' },
      { id: 'rs_stable', encryptedContent: 'ENC_COMPLETED_1' },
    ],
  ));
  if (res.type !== 'events') throw new Error('expected events');
  assertEquals(completedItems(await collect(res.events)), [
    ['done_id_0', 'ENC_DONE_0'],
    ['rs_stable', 'ENC_DONE_1'],
  ]);
});

// An item that surfaced only at the terminal envelope (no streamed
// `output_item.done`) has no canonical entry to pin against, so the item
// passes through unchanged.
test('item only at terminal frame: untouched passthrough', async () => {
  const res = await withResponsesOutputItemsCanonicalized(invocation(), stubCtx, runStream(
    [{ outputIndex: 0, id: 'rs_alpha', encryptedContent: 'ENC_DONE' }],
    [
      { id: 'rs_alpha', encryptedContent: 'ENC_COMPLETED' },
      { id: 'rs_terminal_only', encryptedContent: 'ENC_TERMINAL' },
    ],
  ));
  if (res.type !== 'events') throw new Error('expected events');
  assertEquals(completedItems(await collect(res.events)), [
    ['rs_alpha', 'ENC_DONE'],
    ['rs_terminal_only', 'ENC_TERMINAL'],
  ]);
});
