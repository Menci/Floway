import { hashResponsesItem, responsesItemId } from './identity.ts';
import type { StatefulResponsesStore } from './store.ts';
import type { StoredResponsesItem } from '../../../../repo/types.ts';
import { doneFrame, eventFrame, type ProtocolFrame } from '@floway-dev/protocols/common';
import { responsesResultToEvents, type ResponsesCompactionResult, type ResponsesOutputItem, type ResponsesResult, type ResponsesStreamEvent } from '@floway-dev/protocols/responses';

// Floway derives canonical output identity from `response.output_item.done`
// lifecycles. Normalize terminal snapshots from that ordered set before
// downstream transforms so affinity, persistence, and resource completion
// cannot interpret array positions as different items. When no item closed,
// preserve the terminal snapshot as the sole observation.
// https://github.com/openresponses/openresponses/blob/92c12d96d7b61d6d15e2214daa5e9c6000ab6e1c/src/specifications/2026-04-24.mdx#L313-L337
export const wrapResponsesObservedOutput = async function* (
  frames: AsyncIterable<ProtocolFrame<ResponsesStreamEvent>>,
): AsyncGenerator<ProtocolFrame<ResponsesStreamEvent>> {
  const observed = new Map<number, ResponsesOutputItem>();
  for await (const frame of frames) {
    if (frame.type !== 'event') {
      yield frame;
      continue;
    }
    const event = frame.event;
    if (event.type === 'response.output_item.done') {
      observed.set(event.output_index, event.item);
      yield frame;
      continue;
    }
    if (
      observed.size > 0
      && (event.type === 'response.completed' || event.type === 'response.incomplete' || event.type === 'response.failed')
    ) {
      const output = [...observed].sort(([left], [right]) => left - right).map(([, item]) => item);
      yield eventFrame({ ...event, response: { ...event.response, output } });
      continue;
    }
    yield frame;
  }
};

// Complete output items become reusable at their first done frame, so each row
// commits before that frame is yielded. Later done frames remain
// visible but cannot replace the durable item. The response snapshot commits
// separately before a successful terminal frame. Failed/error terminals keep
// completed item rows but never a snapshot.
//
// One client response can span several upstream calls behind the server-tool
// runtime. The caller mints its envelope id once, and this wrapper applies it
// to every queued/created/in-progress and terminal response envelope without
// changing any output item.
export const wrapResponsesClientOutput = async function* (
  frames: AsyncIterable<ProtocolFrame<ResponsesStreamEvent>>,
  args: {
    readonly store: StatefulResponsesStore;
    readonly responseId: string;
  },
): AsyncGenerator<ProtocolFrame<ResponsesStreamEvent>> {
  const { store, responseId } = args;
  const finalizedOutputIds = new Map<number, string>();
  let sawCompactionItem = false;

  const finalizedRow = async (item: ResponsesOutputItem): Promise<StoredResponsesItem> => {
    const id = responsesItemId(item);
    if (id === null) throw new TypeError(`Responses ${item.type} output has no id`);
    const privatePayload = store.getPrivatePayload(id);
    const row: StoredResponsesItem = {
      id,
      apiKeyId: store.apiKeyId,
      payload: {
        item,
        ...(privatePayload !== undefined ? { private: privatePayload } : {}),
      },
      itemHash: await hashResponsesItem(item),
      refreshedAt: Date.now(),
    };
    return row;
  };

  const persistFinalizedItem = async (item: ResponsesOutputItem, outputIndex: number): Promise<void> => {
    if (finalizedOutputIds.has(outputIndex)) return;
    const row = await finalizedRow(item);
    await store.persistOutputItem(row);
    finalizedOutputIds.set(outputIndex, row.id);
  };

  const clientEnvelope = (response: ResponsesResult): ResponsesResult => ({
    ...response,
    id: responseId,
  });

  for await (const frame of frames) {
    if (frame.type !== 'event') {
      yield frame;
      continue;
    }
    const event = frame.event;

    if (event.type === 'response.queued' || event.type === 'response.created' || event.type === 'response.in_progress') {
      yield eventFrame({ ...event, response: clientEnvelope(event.response) });
      continue;
    }

    if (event.type === 'response.output_item.done') {
      if (store.writesState) {
        if (event.item.type === 'compaction') sawCompactionItem = true;
        await persistFinalizedItem(event.item, event.output_index);
      }
      yield frame;
      continue;
    }

    if (event.type === 'response.completed' || event.type === 'response.incomplete') {
      if (store.writesState) {
        // A terminal may restate fewer items than the turn closed, but never
        // one that never closed: that item reached the client without the
        // lifecycle the spec requires of it.
        event.response.output.forEach((_item, outputIndex) => {
          if (!finalizedOutputIds.has(outputIndex)) {
            throw new TypeError(`Responses terminal output_index ${outputIndex} arrived before output_item.done`);
          }
        });
        // The snapshot a `previous_response_id` continuation replays is the
        // items this turn closed, in `output_index` order; taking the terminal's
        // own restatement would drop the assistant's message from the history
        // the next turn continues from.
        const orderedOutputIds = [...finalizedOutputIds]
          .sort(([left], [right]) => left - right)
          .map(([, id]) => id);
        await store.commitSnapshot(responseId, sawCompactionItem ? 'replace' : 'append', orderedOutputIds);
      }
      yield eventFrame({ ...event, response: clientEnvelope(event.response) });
      return;
    }

    if (event.type === 'response.failed') {
      yield eventFrame({ ...event, response: clientEnvelope(event.response) });
      return;
    }
    if (event.type === 'error') {
      yield frame;
      return;
    }

    yield frame;
  }
};

// A non-streaming compact result enters the same persistence path as a live
// stream. Every complete item gets an added/done pair before the terminal
// envelope, followed by the regular done sentinel.
export const syntheticEventsFromResult = async function* (result: ResponsesResult): AsyncIterable<ProtocolFrame<ResponsesStreamEvent>> {
  yield* responsesResultToEvents(result, { genericOutputItems: true });
  yield doneFrame();
};

// `ResponsesCompactionResult` states no `status`, so the terminal is stated
// here rather than read off the body: a compaction that got this far is one the
// upstream answered 200, and there is no spelling for a failed one. Widening it
// back to `ResponsesResult` is safe because the expansion reads no
// response-only field — it spreads whatever the body carried.
export const syntheticEventsFromCompaction = async function* (result: ResponsesCompactionResult): AsyncIterable<ProtocolFrame<ResponsesStreamEvent>> {
  yield* responsesResultToEvents(result as unknown as ResponsesResult, { genericOutputItems: true, terminal: 'response.completed' });  yield doneFrame();
};
