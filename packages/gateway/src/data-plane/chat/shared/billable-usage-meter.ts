// Reads what an upstream turn cost off that turn's own event stream, as an
// interceptor rather than at the terminal that calls the provider.
//
// The position is the whole point. An upstream's usage reaches us in the
// dialect it happens to speak: DeepSeek states its cached prefix as
// `prompt_cache_hit_tokens`, Kimi as a flat `cached_tokens`, and a gateway
// fronting an Anthropic-shaped model reports the cache buckets alongside the
// input total instead of inside it. The interceptors that repair all of this
// — `vendor-<X>-normalize`, `normalize-exclusive-cached-tokens` — rewrite the
// inbound stream, so a figure read below them is read from a dialect no
// reader is written against: at best it under-counts the cache buckets and
// bills them at the full input rate, at worst the split underflows and tears
// the response down mid-stream.
//
// So the meter runs above every entry that rewrites usage, and below every
// entry that owns turn composition or answers without an upstream:
//
//   - Below a multi-turn shim, so each of that shim's `run()` turns is
//     metered on its own and the shim sums the turns it stitched. A meter
//     above it would instead read the stitched stream, whose synthesized
//     usage carries only what that shim chose to re-emit.
//   - Below a short-circuiting entry, so a turn that never dialed an upstream
//     keeps its absent metadata rather than being billed for zero tokens.
//   - Per `run()`, which is also what makes a stateful reader correct: the
//     Messages reader merges `message_start` and `message_delta` into one
//     running figure and is scoped to a single turn.
//
// The contribution is merge-shaped: only `billableUsage` is written, so a
// shim's latest-turn `modelIdentity` and `performance` survive, and a turn
// that already stated its cost outside any stream — a native Responses
// compaction, whose body carries the counts — keeps the figure it published.

import { eventResultMetadata } from './respond.ts';
import type { Interceptor } from '@floway-dev/interceptor';
import type { BillableUsage, ProtocolFrame } from '@floway-dev/protocols/common';
import type { ChatTargetApi, EventResultMetadata, ExecuteResult } from '@floway-dev/provider';

export const meteringBillableUsage = <TInvocation extends { readonly targetApi: ChatTargetApi }, TEnv, TEvent>(
  // The protocol this chain speaks natively. A translated request re-enters
  // its target's chain, where that chain's own meter reads the upstream's own
  // usage and `traverseTranslation` carries the figure back out; metering the
  // translation here as well would double-count it.
  nativeApi: ChatTargetApi,
  createReader: () => (event: TEvent) => BillableUsage | null,
): Interceptor<TInvocation, TEnv, ExecuteResult<ProtocolFrame<TEvent>>> => async (ctx, _env, run) => {
  if (ctx.targetApi !== nativeApi) return await run();

  const result = await run();
  if (result.type !== 'events') return result;

  const read = createReader();
  // Only a report carrying real counts replaces the running figure, so a
  // trailing empty usage frame cannot wipe a good one.
  let billableUsage: BillableUsage | undefined;
  let resolveFinal!: (metadata: EventResultMetadata) => void;
  const finalMetadata = new Promise<EventResultMetadata>(resolve => { resolveFinal = resolve; });

  return {
    ...result,
    finalMetadata,
    events: (async function* () {
      try {
        for await (const frame of result.events) {
          if (frame.type === 'event') {
            const reported = read(frame.event);
            if (reported !== null) billableUsage = reported;
          }
          yield frame;
        }
      } finally {
        // Settles on cancellation too: `respond` returns at the terminal frame
        // and closes the iterator rather than draining it, and that turn is
        // billed like any other. The inner metadata has already settled by
        // then — closing this generator closes the one it reads from first.
        resolveFinal({
          ...(await eventResultMetadata(result)),
          ...(billableUsage !== undefined ? { billableUsage } : {}),
        });
      }
    })(),
  };
};
