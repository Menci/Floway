import type { OpenAIResponsesInterceptor } from './types.ts';
import { telemetryModelIdentity } from '../../../shared/telemetry/attribution.ts';
import { syntheticEventsFromResult } from '../items/output.ts';
import type { OpenAIResponsesResult } from '@floway-dev/protocols/openai-responses';
import { eventResult, providerModelOf } from '@floway-dev/provider';

// Codex opens every session with a WebSocket prewarm: a `response.create` that
// carries the session's instructions and tools with `generate: false`. It is
// connection setup rather than inference, so Codex waits only for the terminal
// `response.completed` and then continues from that response's id, sending
// just the items the prewarm did not already carry.
// https://github.com/openai/codex/blob/6989c6548b3737f108e2bb5ae1171b1d2032e30c/codex-rs/core/src/client.rs#L17-L18
// https://github.com/openai/codex/blob/6989c6548b3737f108e2bb5ae1171b1d2032e30c/codex-rs/core/src/client.rs#L2025
// https://github.com/openai/codex/blob/6989c6548b3737f108e2bb5ae1171b1d2032e30c/codex-rs/core/src/client.rs#L2181-L2184
//
// No upstream call can stand in for it. The Codex HTTP backend rejects the
// field with `{"detail":"Unsupported parameter: generate"}`, and a translated
// target drops it and runs a full, billed generation. The gateway answers the
// prewarm itself: by now serve preparation has resolved the model, expanded
// any `previous_response_id`, and staged this request's input, so the empty
// completed response commits a snapshot of exactly that input and the next
// turn's continuation replays it. An id no upstream serves still fails before
// this runs.
//
// No `performance` context on the result: a turn that never dialed the
// upstream has no latency to report. The usage row still lands, at zero, so the
// request stays visible in the dashboard.
export const answerWebSocketWarmup: OpenAIResponsesInterceptor = async (ctx, _gatewayCtx, run) => {
  if (ctx.payload.generate !== false) return await run();
  const result: OpenAIResponsesResult = {
    // Replaced by the client-output boundary's own response id.
    id: '',
    object: 'response',
    model: ctx.payload.model,
    status: 'completed',
    output: [],
    error: null,
    incomplete_details: null,
    usage: { input_tokens: 0, output_tokens: 0, total_tokens: 0 },
  };
  return eventResult(syntheticEventsFromResult(result), telemetryModelIdentity(ctx.candidate, providerModelOf(ctx.candidate).id));
};
