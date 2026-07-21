import { canonicalResponsesItemType, createResponsesItemId, hashResponsesItemContent, responsesItemId } from './format.ts';
import type { StatefulResponsesStore } from './store.ts';
import type { StoredResponsesItem } from '../../../../repo/types.ts';
import { doneFrame, eventFrame, type ProtocolFrame } from '@floway-dev/protocols/common';
import { responsesResultToEvents, type ResponsesOutputItem, type ResponsesResult, type ResponsesStreamEvent } from '@floway-dev/protocols/responses';

// Mints gateway-owned item ids and presents finalized client items to the
// configured state store when it has a write target; without one (HTTP
// store=false) item ids pass through so the origin upstream still recognizes
// them next turn. Translated inner Responses attempts never enter this
// membrane.
//
// Complete items become reusable at their `done` frame, so each row commits
// before that frame is yielded. The response snapshot commits separately before
// a successful terminal frame. Failed/error terminals keep completed item rows
// but never a snapshot. These writes are protocol state, not telemetry.
//
// Wrap is also the single source of truth for the response envelope id the
// client sees. The caller mints a `resp_<crc>_<body>` once and passes it
// in here; every envelope event (`response.queued`, `response.created`, `response.in_progress`,
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
export const wrapResponsesClientOutput = async function* (
  frames: AsyncIterable<ProtocolFrame<ResponsesStreamEvent>>,
  args: {
    readonly store: StatefulResponsesStore;
    readonly responseId: string;
  },
): AsyncGenerator<ProtocolFrame<ResponsesStreamEvent>> {
  const { store, responseId } = args;
  const upstreamToClient = new Map<string, string>();
  const outputIndexToClient = new Map<number, string>();

  // A gateway-minted item id is only worth issuing when the mapping back to its
  // upstream origin is persisted (store.writesState) — otherwise a later turn
  // that echoes the id has no row to restore it from. When no state is written
  // (HTTP store=false), the upstream item id passes through unchanged, so the
  // client carries an id the origin upstream still recognizes next turn. The
  // response envelope id below stays gateway-owned regardless.
  const clientIdForUpstreamId = (upstreamId: string, itemType: string): string => {
    if (!store.writesState) return upstreamId;
    let clientId = upstreamToClient.get(upstreamId);
    if (clientId === undefined) {
      clientId = createResponsesItemId(itemType);
      upstreamToClient.set(upstreamId, clientId);
    }
    return clientId;
  };

  const clientIdForOutput = (upstreamId: string | null, itemType: string, outputIndex: number): string => {
    if (!store.writesState && upstreamId !== null) return upstreamId;
    let clientId = outputIndexToClient.get(outputIndex);
    if (clientId === undefined) {
      clientId = upstreamId === null ? createResponsesItemId(itemType) : clientIdForUpstreamId(upstreamId, itemType);
      outputIndexToClient.set(outputIndex, clientId);
    } else if (upstreamId !== null) {
      upstreamToClient.set(upstreamId, clientId);
    }
    return clientId;
  };

  const persistFinalizedItem = async (originalItem: ResponsesOutputItem, newId: string, outputIndex: number): Promise<void> => {
    if (!store.writesState) return;
    const wireId = responsesItemId(originalItem);
    const source = wireId === null ? null : store.outputItemSource(wireId);
    // Interceptors register per-item server-only payloads under the wire id.
    // Attaching it lets a later turn restore the real success/failure state
    // even when the client stripped fields from the echoed wire item.
    const privatePayload = wireId === null ? undefined : store.getPrivatePayload(wireId);
    const clientItem = { ...originalItem, id: newId } as ResponsesOutputItem;
    const persistedPayload = privatePayload !== undefined ? { item: clientItem, private: privatePayload } : { item: clientItem };
    const now = Date.now();
    const row: StoredResponsesItem = {
      id: newId,
      apiKeyId: store.apiKeyId,
      upstreamId: source?.upstreamId ?? null,
      upstreamItemId: source?.upstreamItemId ?? null,
      itemType: canonicalResponsesItemType(originalItem.type),
      payload: persistedPayload,
      contentHash: await hashResponsesItemContent(clientItem),
      createdAt: now,
    };
    await store.persistOutputItem(row, outputIndex);
  };

  // Fallback for an out-of-order delta that references an upstream id before
  // its output-index lifecycle is available.
  const seenItemTypes = new Map<string, string>();
  let sawCompactionItem = false;

  const rewriteEnvelopeIds = (response: ResponsesResult): ResponsesResult => ({
    ...response,
    id: responseId,
    output: response.output.map((item, outputIndex) => {
      const upstreamId = responsesItemId(item);
      if (upstreamId !== null) seenItemTypes.set(upstreamId, item.type);
      return { ...item, id: clientIdForOutput(upstreamId, item.type, outputIndex) };
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
    if (event.type === 'response.queued' || event.type === 'response.created' || event.type === 'response.in_progress') {
      yield eventFrame({ ...event, response: rewriteEnvelopeIds(event.response) });
      continue;
    }

    if (event.type === 'response.output_item.added') {
      const upstreamId = responsesItemId(event.item);
      if (upstreamId !== null) seenItemTypes.set(upstreamId, event.item.type);
      const newId = clientIdForOutput(upstreamId, event.item.type, event.output_index);
      yield eventFrame({ ...event, item: { ...event.item, id: newId } });
      continue;
    }

    if (event.type === 'response.output_item.done') {
      const upstreamId = responsesItemId(event.item);
      if (upstreamId !== null) seenItemTypes.set(upstreamId, event.item.type);
      const newId = clientIdForOutput(upstreamId, event.item.type, event.output_index);
      if (isCompactionItemType(event.item.type)) sawCompactionItem = true;
      await persistFinalizedItem(event.item, newId, event.output_index);
      yield eventFrame({ ...event, item: { ...event.item, id: newId } });
      continue;
    }

    if (event.type === 'response.completed' || event.type === 'response.incomplete') {
      const output: ResponsesOutputItem[] = [];
      for (const [outputIndex, item] of event.response.output.entries()) {
        if (isCompactionItemType(item.type)) sawCompactionItem = true;
        const upstreamId = responsesItemId(item);
        if (upstreamId !== null) seenItemTypes.set(upstreamId, item.type);
        const newId = clientIdForOutput(upstreamId, item.type, outputIndex);
        await persistFinalizedItem(item, newId, outputIndex);
        output.push({ ...item, id: newId } as ResponsesOutputItem);
      }
      const rewritten = eventFrame({
        ...event,
        response: { ...event.response, id: responseId, output: output as typeof event.response.output },
      });
      if (store.writesState) await store.commitSnapshot(responseId, sawCompactionItem ? 'replace' : 'append');
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

    if ('item_id' in event) {
      const refId = event.item_id;
      const lifecycleItemId = outputIndexToClient.get(event.output_index);
      if (lifecycleItemId !== undefined) {
        upstreamToClient.set(refId, lifecycleItemId);
        yield eventFrame({ ...event, item_id: lifecycleItemId } as ResponsesStreamEvent);
        continue;
      }
      const knownType = seenItemTypes.get(refId);
      if (knownType === undefined) { yield frame; continue; }
      const newId = clientIdForUpstreamId(refId, knownType);
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
// terminated by a done sentinel frame. Lets `wrapResponsesClientOutput`
// consume the result without a real provider call.
export const syntheticEventsFromResult = async function* (result: ResponsesResult): AsyncIterable<ProtocolFrame<ResponsesStreamEvent>> {
  yield* responsesResultToEvents(result, { genericOutputItems: true });
  yield doneFrame();
};
