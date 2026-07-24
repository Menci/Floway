import { hashResponsesItemContent, responsesItemId } from './identity.ts';
import type { StatefulResponsesStore } from './store.ts';
import type { StoredResponsesItem } from '../../../../repo/types.ts';
import { doneFrame, eventFrame, type ProtocolFrame } from '@floway-dev/protocols/common';
import { responsesResultToEvents, type ResponsesOutputItem, type ResponsesResult, type ResponsesStreamEvent } from '@floway-dev/protocols/responses';

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
      itemHash: await hashResponsesItemContent(item),
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
        const orderedOutputIds = event.response.output.map((_item, outputIndex) => {
          const id = finalizedOutputIds.get(outputIndex);
          if (id === undefined) {
            throw new TypeError(`Responses terminal output_index ${outputIndex} arrived before output_item.done`);
          }
          return id;
        });
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
