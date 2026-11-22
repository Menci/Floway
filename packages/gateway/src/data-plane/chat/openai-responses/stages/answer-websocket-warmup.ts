import type { OpenAIResponsesStageFacts, OpenAIResponsesStageOutcome } from './facts.ts';
import { routeCandidateModelIdentity } from '../../../pipeline/failover.ts';
import type { ChatPipelineServices } from '../../pipeline/index.ts';
import { syntheticEventsFromResult } from '../items/output.ts';
import { defineStage } from '@floway-dev/pipeline';
import type { OpenAIResponsesResultEx } from '@floway-dev/protocols/openai-responses';

// Codex opens every session with a WebSocket prewarm: a `response.create` that
// carries the session's instructions and tools with `generate: false`.
// https://github.com/openai/codex/blob/6989c6548b3737f108e2bb5ae1171b1d2032e30c/codex-rs/core/src/client.rs#L17-L18
// https://github.com/openai/codex/blob/6989c6548b3737f108e2bb5ae1171b1d2032e30c/codex-rs/core/src/client.rs#L2025
// https://github.com/openai/codex/blob/6989c6548b3737f108e2bb5ae1171b1d2032e30c/codex-rs/core/src/client.rs#L2181-L2184
export const answerWebSocketWarmup = defineStage<
  OpenAIResponsesStageFacts,
  Record<never, never>,
  OpenAIResponsesStageOutcome,
  OpenAIResponsesStageOutcome,
  never,
  ChatPipelineServices
>({
  name: 'answerWebSocketWarmup',
  execute: async (facts, next, env) => {
    if (facts['request.payload'].generate !== false) return await next();
    const result: OpenAIResponsesResultEx = {
      // Replaced by the client-output boundary's own response id.
      id: '',
      object: 'response',
      model: facts['request.payload'].model,
      status: 'completed',
      output: [],
      error: null,
      incomplete_details: null,
      usage: { input_tokens: 0, output_tokens: 0, total_tokens: 0 },
    };
    return {
      type: 'events',
      events: env.createStream({
        label: 'openai-responses.websocket-warmup.events',
        async *iterate() {
          yield* syntheticEventsFromResult(result);
        },
      }),
      modelIdentity: routeCandidateModelIdentity(facts['route.candidate'], facts['route.candidate'].upstreamModelId),
    };
  },
});
