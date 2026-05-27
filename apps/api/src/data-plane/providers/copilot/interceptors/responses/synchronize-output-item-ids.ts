import type { ResponsesInterceptor } from '../../../../llm/interceptors.ts';
import type { ResponseStreamEvent, ResponsesStreamEvent } from '@floway-dev/protocols/responses';

/**
 * Copilot's `/responses` stream is inconsistent about per-output-item ids:
 *
 *   1. The `response.output_item.added` event may omit `item.id` entirely.
 *   2. The matching `response.output_item.done` event may carry a DIFFERENT
 *      `item.id` than the one that was on `.added`.
 *   3. Mid-item delta/part events (`response.content_part.added`,
 *      `response.output_text.delta`, `response.function_call_arguments.delta`,
 *      etc.) carry an `item_id` that can diverge from BOTH the `.added` and
 *      `.done` ids.
 *
 * Strict downstream consumers (notably `@ai-sdk/openai`) key reasoning /
 * text-part state on `item_id` and crash when these ids fail to line up
 * ("activeReasoningPart.summaryParts" undefined, "text part not found",
 * etc.). We pin the id on `.added` (synthesizing one when missing) and force
 * every later event in the same `output_index` to reuse that pinned id.
 *
 * Lives at the Copilot target boundary so other Responses-capable providers
 * (Azure, OpenAI direct) receive their upstream stream verbatim.
 *
 * References:
 * - https://github.com/caozhiyuan/copilot-api/blob/main/src/routes/responses/stream-id-sync.ts
 * - https://github.com/caozhiyuan/copilot-api/commit/736afa499133a20c83734f2226f2e9639fd23a31
 * - https://github.com/caozhiyuan/copilot-api/commit/4f22448a56b77ac5e5c93e6cdfc24724d3bfdcc7
 */
interface StreamIdTracker {
  outputItemIds: Map<number, string>;
}

// Worker-native random suffix. caozhiyuan uses `Math.random().toString(36)`,
// which is not crypto-grade; we use `crypto.randomUUID()` (available in the
// Workers runtime and modern browsers) and strip its dashes to keep the
// `oi_<output_index>_<16-char>` shape compact and deterministic in length.
const synthesizeItemId = (outputIndex: number): string => {
  const suffix = crypto.randomUUID().replace(/-/g, '').slice(0, 16);
  return `oi_${outputIndex}_${suffix}`;
};

// `response.output_item.added` and `.done` carry the canonical id on
// `item.id`. Every other id-bearing event carries `item_id` directly on the
// envelope. Both shapes are covered by the planner-emitted
// `ResponseStreamEvent` union.
type ItemIdEvent = ResponseStreamEvent & { item_id?: string; output_index?: number };

const fixResponsesStreamIds = (event: ResponsesStreamEvent, tracker: StreamIdTracker): ResponsesStreamEvent => {
  if (event.type === 'response.output_item.added') {
    if (typeof event.output_index !== 'number') return event;
    const item = event.item as { id?: unknown };
    const pinnedId = typeof item.id === 'string' && item.id.length > 0 ? item.id : synthesizeItemId(event.output_index);
    tracker.outputItemIds.set(event.output_index, pinnedId);
    if (item.id === pinnedId) return event;
    return { ...event, item: { ...item, id: pinnedId } } as ResponsesStreamEvent;
  }

  if (event.type === 'response.output_item.done') {
    if (typeof event.output_index !== 'number') return event;
    const pinnedId = tracker.outputItemIds.get(event.output_index);
    if (!pinnedId) return event;
    const item = event.item as { id?: unknown };
    if (item.id === pinnedId) return event;
    return { ...event, item: { ...item, id: pinnedId } } as ResponsesStreamEvent;
  }

  // Any other event that names an output_index AND already declares an
  // item_id is a candidate for rewriting. We do not synthesize an item_id on
  // events that did not have one — that would invent shape on a frame that
  // upstream chose not to tag.
  const carrier = event as ItemIdEvent;
  if (typeof carrier.output_index !== 'number' || typeof carrier.item_id !== 'string') return event;
  const pinnedId = tracker.outputItemIds.get(carrier.output_index);
  if (!pinnedId || carrier.item_id === pinnedId) return event;
  return { ...carrier, item_id: pinnedId } as ResponsesStreamEvent;
};

export const withOutputItemIdsSynchronized: ResponsesInterceptor = async (_ctx, _request, run) => {
  const result = await run();
  if (result.type !== 'events') return result;

  const tracker: StreamIdTracker = { outputItemIds: new Map() };

  return {
    ...result,
    events: (async function* () {
      for await (const frame of result.events) {
        yield frame.type === 'event' ? { ...frame, event: fixResponsesStreamIds(frame.event, tracker) } : frame;
      }
    })(),
  };
};
