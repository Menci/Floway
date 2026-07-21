import { hashResponsesItemContent, responsesItemId } from './identity.ts';
import type { StatefulResponsesStore } from './store.ts';
import type { StoredResponsesItem } from '../../../../repo/types.ts';
import { doneFrame, eventFrame, type ProtocolFrame } from '@floway-dev/protocols/common';
import { responsesResultToEvents, type ResponsesOutputItem, type ResponsesResult, type ResponsesStreamEvent } from '@floway-dev/protocols/responses';

// Complete producer-owned items become reusable at their first done frame, so
// each row commits before that frame is yielded. Later done frames remain
// visible but cannot replace the durable item. The response snapshot commits
// separately before a successful terminal frame. Failed/error terminals keep
// completed item rows but never a snapshot.
//
// Response envelope ids remain Floway-owned because one client response can
// span several upstream calls behind the server-tool runtime. The caller mints
// one id and this wrapper applies it to every queued/created/in-progress and
// terminal response envelope without changing any output item.
export const wrapResponsesClientOutput = async function* (
  frames: AsyncIterable<ProtocolFrame<ResponsesStreamEvent>>,
  args: {
    readonly store: StatefulResponsesStore;
    readonly responseId: string;
  },
): AsyncGenerator<ProtocolFrame<ResponsesStreamEvent>> {
  const { store, responseId } = args;
  const finalizedOutputIndexes = new Set<number>();
  let sawCompactionItem = false;

  const persistFinalizedItem = async (item: ResponsesOutputItem, outputIndex: number): Promise<void> => {
    if (finalizedOutputIndexes.has(outputIndex)) return;
    const id = responsesItemId(item);
    if (id === null) throw new TypeError(`Responses ${item.type} output has no producer id`);
    const privatePayload = store.getPrivatePayload(id);
    const row: StoredResponsesItem = {
      id,
      apiKeyId: store.apiKeyId,
      payload: privatePayload === undefined
        ? { item: structuredClone(item) }
        : { item: structuredClone(item), private: privatePayload },
      contentHash: await hashResponsesItemContent(item),
      createdAt: Date.now(),
    };
    await store.persistOutputItem(row, outputIndex);
    finalizedOutputIndexes.add(outputIndex);
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
      if (isCompactionItemType(event.item.type)) sawCompactionItem = true;
      await persistFinalizedItem(event.item, event.output_index);
      yield frame;
      continue;
    }

    if (event.type === 'response.completed' || event.type === 'response.incomplete') {
      for (const [outputIndex, item] of event.response.output.entries()) {
        if (isCompactionItemType(item.type)) sawCompactionItem = true;
        await persistFinalizedItem(item, outputIndex);
      }
      if (store.writesState) {
        await store.commitSnapshot(responseId, sawCompactionItem ? 'replace' : 'append');
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

// `compaction` and `compaction_summary` are the same wire variant — Codex's
// protocol declares the latter as a serde alias for the former.
// https://github.com/openai/codex/blob/9e552e9d15ba52bed7077d5357f3e18e330f8f38/codex-rs/protocol/src/models.rs#L1135-L1148
const isCompactionItemType = (type: string): boolean =>
  type === 'compaction' || type === 'compaction_summary';

// A non-streaming compact result enters the same durability membrane as a live
// stream. Every complete item gets an added/done pair before the terminal
// envelope, followed by the regular done sentinel.
export const syntheticEventsFromResult = async function* (result: ResponsesResult): AsyncIterable<ProtocolFrame<ResponsesStreamEvent>> {
  yield* responsesResultToEvents(result, { genericOutputItems: true });
  yield doneFrame();
};
