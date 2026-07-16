import { createStoredResponsesItemId, responsesItemId } from './format.ts';
import type { StatefulResponsesStore } from './store.ts';
import type { StoredResponsesItem } from '../../../../repo/types.ts';
import type { ResponsesAttemptState } from '../attempt-state.ts';
import { doneFrame, eventFrame, type ProtocolFrame } from '@floway-dev/protocols/common';
import { responsesResultToEvents, type ResponsesInputItem, type ResponsesResult, type ResponsesStreamEvent } from '@floway-dev/protocols/responses';

// Mints gateway-owned ids and persists the exact affinity-wrapped client item.
// The native Responses source edge owns this transform; translated inner
// Responses attempts never enter it.
//
// Items are committed at their `done` frame and the snapshot is committed
// at the terminal `response.completed` / `response.incomplete` frame.
// Both writes are protocol state, not best-effort telemetry: their failures
// propagate so the client never receives `done` / a successful terminal frame
// for ids that cannot be referenced on its next turn. Streaming clients may
// already have seen the item's `added` frame and deltas, but without `done`
// they must treat that partial item as failed.
//
// Wrap is also the single source of truth for the response envelope id the
// client sees. The caller mints a `resp_<crc>_<body>` once and passes it
// in here; every envelope event (`response.created`, `response.in_progress`,
// `response.completed`, `response.incomplete`, `response.failed`) yielded
// downstream has its `response.id` rewritten to it, and the snapshot is
// committed under the same id. Whatever id the upstream produced
// (Copilot's encrypted blob, OpenAI's `resp_*`, the server-tool runtime's
// internal `resp_shim_*` placeholder) is discarded at this seam — we never
// persist or surface an upstream-owned response id.
//
// Snapshot mode is decided by observing the output stream: when any output
// item carries `type === 'compaction'` (or its wire alias
// `compaction_summary` — Codex's protocol pins them as the same variant via
// `#[serde(alias = "compaction_summary")]`), the turn's output is a
// self-contained compaction envelope and the snapshot mode is `'replace'`;
// otherwise `'append'`. This captures every shape that produces a
// compaction-shape envelope — the native `/v1/responses/compact` endpoint,
// a `compaction_trigger` input on `/v1/responses` (Codex's RemoteCompactionV2),
// and the server-side `context_management` `compact_threshold` mode — without
// each path needing its own gateway-side detector.
export const wrapResponsesOutputForStorage = async function* (
  frames: AsyncIterable<ProtocolFrame<ResponsesStreamEvent>>,
  args: {
    readonly store: StatefulResponsesStore;
    readonly attemptState: ResponsesAttemptState;
    readonly responseId: string;
  },
): AsyncGenerator<ProtocolFrame<ResponsesStreamEvent>> {
  const { store, attemptState, responseId } = args;
  const upstreamToStored = new Map<string, string>();

  const idMapper = (upstreamId: string, itemType: string): string => {
    let storedId = upstreamToStored.get(upstreamId);
    if (storedId === undefined) {
      storedId = createStoredResponsesItemId(itemType);
      upstreamToStored.set(upstreamId, storedId);
    }
    return storedId;
  };

  const onItemFinalized = async (originalItem: ResponsesInputItem, newId: string): Promise<void> => {
    const upstreamId = responsesItemId(originalItem);
    if (upstreamId === null) {
      throw new Error(`Cannot persist Responses item without an upstream id (newId=${newId}, type=${originalItem.type})`);
    }
    // Interceptors register per-item server-only payloads under the wire id.
    // Attaching it lets a later turn restore the real success/failure state
    // even when the client stripped fields from the echoed wire item.
    const privatePayload = attemptState.getPrivatePayload(upstreamId);
    const clientItem = { ...originalItem, id: newId } as ResponsesInputItem;
    const persistedPayload = privatePayload !== undefined ? { item: clientItem, private: privatePayload } : { item: clientItem };
    const now = Date.now();
    const row: StoredResponsesItem = {
      id: newId,
      apiKeyId: store.apiKeyId,
      itemType: originalItem.type,
      payload: persistedPayload,
      contentHash: await store.hashItemContent(clientItem),
      createdAt: now,
    };
    store.stageOutputItem(row);
    await store.commitOutputItems();
  };

  // `seenItemTypes` records item type for every upstream id we have mapped
  // via an item-bearing frame. Delta events carry only `item_id` with no
  // type, so we look the type up before re-invoking idMapper.
  const seenItemTypes = new Map<string, string>();
  const finalized = new Set<string>();
  let sawCompactionItem = false;

  const rewriteEnvelopeIds = (response: ResponsesResult): ResponsesResult => ({
    ...response,
    id: responseId,
    output: response.output.map(item => {
      const upstreamId = responsesItemId(item);
      if (upstreamId === null) return item;
      seenItemTypes.set(upstreamId, item.type);
      return { ...item, id: idMapper(upstreamId, item.type) };
    }),
  });

  for await (const frame of frames) {
    if (frame.type !== 'event') {
      yield frame;
      continue;
    }
    const event = frame.event;

    // Envelope events that carry `response.id` — overwrite to the
    // gateway-minted id before any downstream consumer (SSE writer, WS
    // forwarder, snapshot collector) sees them. Item-level events
    // (`response.output_item.*`, delta events) do not carry `response.id`
    // and are handled below.
    if (event.type === 'response.created' || event.type === 'response.in_progress') {
      yield eventFrame({ ...event, response: rewriteEnvelopeIds(event.response) });
      continue;
    }

    if (event.type === 'response.output_item.added') {
      const upstreamId = responsesItemId(event.item);
      if (upstreamId === null) { yield frame; continue; }
      seenItemTypes.set(upstreamId, event.item.type);
      const newId = idMapper(upstreamId, event.item.type);
      yield eventFrame({ ...event, item: { ...event.item, id: newId } });
      continue;
    }

    if (event.type === 'response.output_item.done') {
      const upstreamId = responsesItemId(event.item);
      if (upstreamId === null) { yield frame; continue; }
      seenItemTypes.set(upstreamId, event.item.type);
      const newId = idMapper(upstreamId, event.item.type);
      if (isCompactionItemType(event.item.type)) sawCompactionItem = true;
      if (!finalized.has(upstreamId)) {
        finalized.add(upstreamId);
        await onItemFinalized(event.item as unknown as ResponsesInputItem, newId);
      }
      yield eventFrame({ ...event, item: { ...event.item, id: newId } });
      continue;
    }

    if (event.type === 'response.completed' || event.type === 'response.incomplete') {
      const output: ResponsesInputItem[] = [];
      for (const item of event.response.output) {
        if (isCompactionItemType(item.type)) sawCompactionItem = true;
        const upstreamId = responsesItemId(item);
        if (upstreamId === null) { output.push(item as unknown as ResponsesInputItem); continue; }
        seenItemTypes.set(upstreamId, item.type);
        const newId = idMapper(upstreamId, item.type);
        if (!finalized.has(upstreamId)) {
          finalized.add(upstreamId);
          await onItemFinalized(item as unknown as ResponsesInputItem, newId);
        }
        output.push({ ...(item as unknown as ResponsesInputItem), id: newId });
      }
      const rewritten = eventFrame({
        ...event,
        response: { ...event.response, id: responseId, output: output as typeof event.response.output },
      });
      // Commit BEFORE yielding the terminal frame: a consumer that
      // breaks the for-await on the terminal yield never gives this
      // generator another tick, so any post-yield work would be lost.
      // The downstream HTTP entry has nothing to observe pre-snapshot —
      // ordering matches a synchronous emit.
      await store.commitSnapshot(responseId, sawCompactionItem ? 'replace' : 'append');
      yield rewritten;
      return;
    }

    if (event.type === 'response.failed') {
      yield eventFrame({ ...event, response: rewriteEnvelopeIds(event.response) });
      return;
    }
    if (event.type === 'error') {
      yield frame;
      return;
    }

    const refId = (event as { item_id?: unknown }).item_id;
    if (typeof refId === 'string') {
      const knownType = seenItemTypes.get(refId);
      if (knownType === undefined) { yield frame; continue; }
      const newId = idMapper(refId, knownType);
      yield eventFrame({ ...event, item_id: newId } as ResponsesStreamEvent);
      continue;
    }
    yield frame;
  }
};

// `compaction` and `compaction_summary` are the same wire variant — Codex's
// protocol declares the latter as a serde alias for the former (see
// https://github.com/openai/codex/blob/9e552e9d15ba52bed7077d5357f3e18e330f8f38/codex-rs/protocol/src/models.rs#L1135-L1148).
// An output stream carrying either is a self-contained compaction envelope
// and replaces the conversation history.
const isCompactionItemType = (type: string): boolean =>
  type === 'compaction' || type === 'compaction_summary';

// Expands a non-streaming compact result into the same frame sequence a live
// upstream would emit: every output item as bare added/done pairs (no inner
// content delta events) via `responsesResultToEvents` with genericOutputItems,
// terminated by a done sentinel frame. Lets `wrapResponsesOutputForStorage`
// consume the result without a real provider call.
export const syntheticEventsFromResult = async function* (result: ResponsesResult): AsyncIterable<ProtocolFrame<ResponsesStreamEvent>> {
  yield* responsesResultToEvents(result, { genericOutputItems: true });
  yield doneFrame();
};
