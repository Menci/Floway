import type { ProtocolFrame } from '@floway-dev/protocols/common';

/**
 * Per-trip context. Carries the model name plus a per-pair-declared `TCaps`
 * shape that lists exactly the capability fields the trip reads. Pairs that
 * need no extra capability fields pass an empty object type. Callers
 * (typically source serves) construct one wide context whose shape is the
 * union of every pair's TCaps and reuse it across the dispatch map.
 *
 * The client's stream preference is intentionally not in this context.
 * Translation always emits `stream: true` on the target payload; the LLM
 * upstream layer enforces SSE streaming and source `respond.ts` boundaries
 * collect a non-streamed downstream response when the client did not ask
 * for SSE.
 */
export type TranslationContext<TCaps = unknown> = {
  readonly model: string;
} & TCaps;

/**
 * One pairwise translation trip. The function body owns the trip: it builds
 * the target payload and returns an events translator closure that maps
 * target-protocol events back into source-protocol events. Trip-scoped state
 * (synthetic ids, custom-tool name sets, etc.) lives as locals captured by
 * the returned closure — the source serve never sees them.
 *
 * Stateless pairs simply return a function reference for `events`. Stateful
 * pairs let the closure capture whatever locals the trip needs.
 *
 * `TCaps` is the pair-declared capability surface: each pair lists exactly
 * the fields it reads from `TranslationContext`. Pairs that do not need any
 * upstream capability data leave it as `unknown` (default).
 */
export type TranslateTrip<SrcPayload, SrcEvent, TgtPayload extends { model: string }, TgtEvent, TCaps = unknown> = (
  src: SrcPayload,
  ctx: TranslationContext<TCaps>,
) => Promise<{
  target: TgtPayload;
  events: (frames: AsyncIterable<ProtocolFrame<TgtEvent>>) => AsyncIterable<ProtocolFrame<SrcEvent>>;
}>;

/**
 * Minimal events-branch contract the caller's result envelope must satisfy
 * so `viaTranslation` can rewrap events without knowing the rest of the
 * envelope shape. Other branches pass through unchanged.
 */
export interface EventsBranch<TEvent> {
  type: 'events';
  events: AsyncIterable<ProtocolFrame<TEvent>>;
}

/**
 * Common signature for native and translated source emits. The source serve
 * holds a `Record<LlmTargetApi, SourceEmit<...>>` and dispatches without
 * branching on whether translation occurred. The result envelope `TResult`
 * is caller-defined (apps/api uses `ExecuteResult<ProtocolFrame<SrcEvent>>`).
 */
export type SourceEmit<SrcPayload, TCaps, TResult> = (
  srcPayload: SrcPayload,
  ctx: TranslationContext<TCaps>,
) => Promise<TResult>;

/**
 * Combine a translation trip with a target-protocol emit into a `SourceEmit`.
 * The caller supplies an `emit` returning their own discriminated result
 * envelope where the `events` branch carries `AsyncIterable<ProtocolFrame<…>>`.
 * Non-events branches pass through unchanged so source error shaping observes
 * the original upstream/internal failure context.
 *
 * Two structural casts. The function relies on `TSrc` and `TTgt` sharing
 * identical non-events branches structurally — typically both are
 * `ExecuteResult<ProtocolFrame<E>>` differing only in the event type — and on
 * each branch carrying envelope fields (`modelIdentity`, `performance`,
 * `finalMetadata`) that the minimal `EventsBranch` interface cannot express.
 * The caller asserts this relationship at the call site by parameterising
 * `TSrc`/`TTgt` with matching envelope shapes; the body preserves the runtime
 * value bit-for-bit and only widens the type-system view via these casts. A
 * single-cast version requires expressing the source envelope as
 * `ReplaceEventsBranch<TResult, SrcEvent>`, which TS cannot prove equal to
 * the non-events slice of the replaced envelope without invasive call-site
 * type assertions, so two casts here keep the source serves clean.
 */
export const viaTranslation = <
  SrcPayload, SrcEvent,
  TgtPayload extends { model: string }, TgtEvent,
  TCaps,
  TTgt extends EventsBranch<TgtEvent> | { type: string },
  TSrc extends EventsBranch<SrcEvent> | { type: string },
>(
  translate: TranslateTrip<SrcPayload, SrcEvent, TgtPayload, TgtEvent, TCaps>,
  emit: (target: TgtPayload) => Promise<TTgt>,
): SourceEmit<SrcPayload, TCaps, TSrc> => async (src, ctx) => {
  const { target, events } = await translate(src, ctx);
  const result = await emit(target);
  // Non-events branches are structurally identical across `TTgt` and `TSrc`
  // by caller contract; pass them through unchanged.
  if (result.type !== 'events') return result as unknown as TSrc;
  // The events branch carries envelope fields the minimal `EventsBranch`
  // interface does not surface; the spread preserves them at runtime, and
  // the cast widens the type-system view to the corresponding source-side
  // envelope.
  const eventsBranch = result as EventsBranch<TgtEvent>;
  return { ...result, events: events(eventsBranch.events) } as unknown as TSrc;
};
