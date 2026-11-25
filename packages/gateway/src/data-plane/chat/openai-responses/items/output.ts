import { hashOpenAIResponsesItem, openaiResponsesItemId } from './identity.ts';
import type { OpenAIResponsesStatefulStore } from './store.ts';
import type { StoredOpenAIResponsesItem } from '../../../../repo/types.ts';
import { doneFrame, eventFrame, type ParsedProtocolFrame, type ProtocolFrame } from '@floway-dev/protocols/common';
import { isOpenAIResponsesCompactionItem, openaiResponsesResultToEvents, type OpenAIResponsesCompactionResultEx, type OpenAIResponsesResultEx, type OpenAIResponsesStreamEventEx } from '@floway-dev/protocols/openai-responses';

// Complete output items become reusable at their first done frame, so each row
// commits before that frame is yielded. Later done frames remain
// visible but cannot replace the durable item. The response snapshot commits
// separately before a successful terminal frame. Failed responses keep
// completed item rows but never a snapshot.
//
// One client response can span several upstream calls behind the server-tool
// runtime. The caller mints its envelope id once, and this wrapper applies it
// to every queued/created/in-progress and terminal response envelope without
// changing any output item.
export const wrapOpenAIResponsesClientOutput = async function* (
  frames: AsyncIterable<ParsedProtocolFrame<OpenAIResponsesStreamEventEx>>,
  args: {
    readonly store: OpenAIResponsesStatefulStore;
    readonly responseId: string;
  },
): AsyncGenerator<ParsedProtocolFrame<OpenAIResponsesStreamEventEx>> {
  const { store, responseId } = args;
  const finalizedOutputIds = new Map<number, string>();
  let sawCompactionItem = false;

  const clientEnvelope = (response: OpenAIResponsesResultEx): OpenAIResponsesResultEx => ({
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

    if (event.type === 'response.output_item.added' || event.type === 'response.output_item.done') {
      const { item } = event;
      const persist = event.type === 'response.output_item.done' && store.writesState && !finalizedOutputIds.has(event.output_index);
      const id = openaiResponsesItemId(item);
      if (id === null && (item.type === 'message' || persist)) {
        const cause = new TypeError(`OpenAI Responses ${item.type} output has no id`);
        yield { type: 'error', cause };
        return;
      }
      if (event.type === 'response.output_item.done' && store.writesState && isOpenAIResponsesCompactionItem(item)) sawCompactionItem = true;
      if (id !== null && persist) {
        const row: StoredOpenAIResponsesItem = {
          id,
          apiKeyId: store.apiKeyId,
          payload: { item },
          itemHash: await hashOpenAIResponsesItem(item),
          refreshedAt: Date.now(),
        };
        await store.persistOutputItem(row);
        finalizedOutputIds.set(event.output_index, id);
      }
      yield frame;
      continue;
    }

    if (event.type === 'response.completed' || event.type === 'response.incomplete') {
      if (event.response.output.some(item => item.type === 'message' && openaiResponsesItemId(item) === null)) {
        const cause = new TypeError('OpenAI Responses message output has no id');
        yield { type: 'error', cause };
        return;
      }
      if (store.writesState) {
        // Persisted snapshots require the lifecycle that made each item
        // reusable. A terminal-only item has not reached that boundary.
        const finalizedIds = new Set(finalizedOutputIds.values());
        const unfinished = event.response.output.findIndex((item, outputIndex) => {
          const id = openaiResponsesItemId(item);
          return (id === null || !finalizedIds.has(id)) && !finalizedOutputIds.has(outputIndex);
        });
        if (unfinished !== -1) {
          const cause = new TypeError(`OpenAI Responses terminal output_index ${unfinished} arrived before output_item.done`);
          yield { type: 'error', cause };
          return;
        }
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
    yield frame;
  }
};

// A non-streaming compact result enters the same persistence path as a live
// stream. Every complete item gets an added/done pair before the terminal
// envelope, followed by the regular done sentinel.
export const syntheticEventsFromResult = async function* (result: OpenAIResponsesResultEx): AsyncIterable<ProtocolFrame<OpenAIResponsesStreamEventEx>> {
  yield* openaiResponsesResultToEvents(result, { genericOutputItems: true });
  yield doneFrame();
};

// `OpenAIResponsesCompactionResult` states no `status`, so the terminal is stated
// here rather than read off the body: a compaction that got this far is one the
// upstream answered 200, and there is no spelling for a failed one. Widening it
// back to `OpenAIResponsesResult` is safe because the expansion reads no
// response-only field — it spreads whatever the body carried.
export const syntheticEventsFromCompaction = async function* (result: OpenAIResponsesCompactionResultEx): AsyncIterable<ProtocolFrame<OpenAIResponsesStreamEventEx>> {
  yield* openaiResponsesResultToEvents(result as unknown as OpenAIResponsesResultEx, { genericOutputItems: true, terminal: 'response.completed' });  yield doneFrame();
};
