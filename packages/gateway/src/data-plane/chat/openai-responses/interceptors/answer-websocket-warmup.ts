import type { OpenAIResponsesInterceptor } from './types.ts';
import { telemetryModelIdentity } from '../../../shared/telemetry/attribution.ts';
import { syntheticEventsFromResult } from '../items/output.ts';
import type { OpenAIResponsesResult } from '@floway-dev/protocols/openai-responses';
import { eventResult, providerModelOf } from '@floway-dev/provider';

// WebSocket `generate: false` prepares request state without model output.
// Codex waits for `response.completed`, then reuses the connection and response
// id while sending only new input. HTTP requests do not have this operation.
// https://developers.openai.com/api/docs/guides/websocket-mode
// https://github.com/openai/codex/blob/6989c6548b3737f108e2bb5ae1171b1d2032e30c/codex-rs/core/src/client.rs#L17-L18
// https://github.com/openai/codex/blob/6989c6548b3737f108e2bb5ae1171b1d2032e30c/codex-rs/core/src/client.rs#L2181-L2184
//
// Our provider calls use HTTP, so we preserve this WebSocket operation locally.
// Serve preparation has already resolved the model, expanded previous state,
// and staged the input. Completing the response commits that snapshot for
// continuation, without turning a prewarm into an upstream generation.
//
// No `performance` context on the result: a turn that never dialed the
// upstream has no latency to report. The usage row still lands, at zero, so the
// request stays visible in the dashboard.
export const answerWebSocketWarmup: OpenAIResponsesInterceptor = async (ctx, gatewayCtx, run) => {
  if (gatewayCtx.transport !== 'websocket' || ctx.payload.generate !== false) return await run();
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
