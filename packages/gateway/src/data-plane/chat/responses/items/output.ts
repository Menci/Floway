import { canonicalResponsesItemType, createResponsesItemId, hashResponsesItemBinding, hashResponsesItemContent, responsesItemId } from './format.ts';
import type { StatefulResponsesStore } from './store.ts';
import type { StoredResponsesItem } from '../../../../repo/types.ts';
import type { ResponsesAttemptState } from '../attempt-state.ts';
import { doneFrame, eventFrame, type ProtocolFrame } from '@floway-dev/protocols/common';
import { responsesResultToEvents, type ResponsesInputItem, type ResponsesResult, type ResponsesStreamEvent } from '@floway-dev/protocols/responses';

// Mints gateway-owned ids and presents finalized client items to the configured
// state store when it has a write target. Translated inner Responses attempts
// never enter this membrane.
//
// Complete items are staged at their `done` frame. The whole output batch and
// its snapshot commit together before a successful terminal frame is yielded.
// Failed/error terminals still commit the completed item batch, but never a
// snapshot. These writes are protocol state, not best-effort telemetry.
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
export const wrapResponsesClientOutput = async function* (
  frames: AsyncIterable<ProtocolFrame<ResponsesStreamEvent>>,
  args: {
    readonly store: StatefulResponsesStore;
    readonly attemptState: ResponsesAttemptState;
    readonly responseId: string;
  },
): AsyncGenerator<ProtocolFrame<ResponsesStreamEvent>> {
  const { store, attemptState, responseId } = args;
  const upstreamToClient = new Map<string, string>();
  const outputIndexToClient = new Map<number, string>();
  const finalizedItems = new Map<number, { readonly itemType: string; readonly contentHash: string }>();

  const clientIdForUpstreamId = (upstreamId: string, itemType: string): string => {
    let clientId = upstreamToClient.get(upstreamId);
    if (clientId === undefined) {
      clientId = createResponsesItemId(itemType);
      upstreamToClient.set(upstreamId, clientId);
    }
    return clientId;
  };

  const clientIdForOutput = (upstreamId: string | null, itemType: string, outputIndex: number): string => {
    let clientId = outputIndexToClient.get(outputIndex);
    if (clientId === undefined) {
      clientId = upstreamId === null ? createResponsesItemId(itemType) : clientIdForUpstreamId(upstreamId, itemType);
      outputIndexToClient.set(outputIndex, clientId);
    } else if (upstreamId !== null) {
      upstreamToClient.set(upstreamId, clientId);
    }
    return clientId;
  };

  const matchesFinalizedItem = async (outputIndex: number, item: ResponsesInputItem): Promise<boolean> => {
    const finalized = finalizedItems.get(outputIndex);
    if (finalized === undefined) return false;
    const contentHash = await hashResponsesItemBinding(item);
    if (finalized.itemType !== canonicalResponsesItemType(item.type) || finalized.contentHash !== contentHash) {
      throw new Error(`Responses output item ${outputIndex} changed after output_item.done`);
    }
    return true;
  };

  const stageFinalizedItem = async (originalItem: ResponsesInputItem, newId: string, outputIndex: number): Promise<void> => {
    if (!store.writesState) return;
    const upstreamId = responsesItemId(originalItem);
    // Interceptors register per-item server-only payloads under the wire id.
    // Attaching it lets a later turn restore the real success/failure state
    // even when the client stripped fields from the echoed wire item.
    const privatePayload = upstreamId === null ? undefined : attemptState.getPrivatePayload(upstreamId);
    const clientItem = { ...originalItem, id: newId } as ResponsesInputItem;
    const persistedPayload = privatePayload !== undefined ? { item: clientItem, private: privatePayload } : { item: clientItem };
    const now = Date.now();
    const row: StoredResponsesItem = {
      id: newId,
      apiKeyId: store.apiKeyId,
      itemType: canonicalResponsesItemType(originalItem.type),
      payload: persistedPayload,
      contentHash: await hashResponsesItemContent(clientItem),
      createdAt: now,
    };
    store.stageOutputItem(row, outputIndex);
  };

  // Fallback for an out-of-order delta that references an upstream id before
  // its output-index lifecycle is available.
  const seenItemTypes = new Map<string, string>();
  let sawCompactionItem = false;
  let stagedOutputCommitStarted = false;
  const commitStagedOutput = async (): Promise<void> => {
    if (!store.writesState || stagedOutputCommitStarted) return;
    stagedOutputCommitStarted = true;
    await store.commitStagedOutputItems();
  };

  const rewriteEnvelopeIds = (response: ResponsesResult): ResponsesResult => ({
    ...response,
    id: responseId,
    output: response.output.map((item, outputIndex) => {
      const upstreamId = responsesItemId(item);
      if (upstreamId !== null) seenItemTypes.set(upstreamId, item.type);
      return { ...item, id: clientIdForOutput(upstreamId, item.type, outputIndex) };
    }),
  });

  try {
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
        if (!await matchesFinalizedItem(event.output_index, event.item as unknown as ResponsesInputItem)) {
          finalizedItems.set(event.output_index, {
            itemType: canonicalResponsesItemType(event.item.type),
            contentHash: await hashResponsesItemBinding(event.item),
          });
          await stageFinalizedItem(event.item as unknown as ResponsesInputItem, newId, event.output_index);
        }
        yield eventFrame({ ...event, item: { ...event.item, id: newId } });
        continue;
      }

      if (event.type === 'response.completed' || event.type === 'response.incomplete') {
        const output: ResponsesInputItem[] = [];
        for (const [outputIndex, item] of event.response.output.entries()) {
          if (isCompactionItemType(item.type)) sawCompactionItem = true;
          const upstreamId = responsesItemId(item);
          if (upstreamId !== null) seenItemTypes.set(upstreamId, item.type);
          const newId = clientIdForOutput(upstreamId, item.type, outputIndex);
          if (!await matchesFinalizedItem(outputIndex, item as unknown as ResponsesInputItem)) {
            await stageFinalizedItem(item as unknown as ResponsesInputItem, newId, outputIndex);
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
        if (store.writesState) {
          stagedOutputCommitStarted = true;
          await store.commitSnapshot(responseId, sawCompactionItem ? 'replace' : 'append');
        }
        yield rewritten;
        return;
      }

      if (event.type === 'response.failed') {
        await commitStagedOutput();
        yield eventFrame({ ...event, response: rewriteEnvelopeIds(event.response) });
        return;
      }
      if (event.type === 'error') {
        await commitStagedOutput();
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
  } catch (error) {
    try {
      await commitStagedOutput();
    } catch (persistenceError) {
      throw new AggregateError([error, persistenceError], 'Responses output failed and completed items could not be persisted');
    }
    throw error;
  } finally {
    await commitStagedOutput();
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
