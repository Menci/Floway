import type { ResponsesBodyBack, ResponsesBodyFacts } from './facts.ts';
import { emptyUsageFacts, usageResponseKeys } from '../../../pipeline/observe-usage.ts';
import type { ResponsesDelivery } from '../encode.ts';
import { syntheticEventsFromResult } from '../items/output.ts';
import { defineStage } from '@floway-dev/pipeline';

// The first Codex WebSocket message prewarms the session. The response ID
// lets the next turn replay the stored input with previous_response_id.
// https://github.com/openai/codex/blob/6989c6548b3737f108e2bb5ae1171b1d2032e30c/codex-rs/core/src/client.rs#L2181-L2184
type Request = ResponsesBodyFacts & { readonly 'request.delivery'?: ResponsesDelivery };

export const answerWebSocketWarmup = defineStage<Request, Request, ResponsesBodyBack, ResponsesBodyBack>({
  name: 'answerWebSocketWarmup',
  through: {
    request: { needs: ['request.openaiResponses'], consumes: [], provides: [] },
    response: { needs: [], consumes: [], provides: [] },
  },
  return: { provides: ['response.http', 'response.openaiResponses', 'response.result', ...usageResponseKeys] },
  execute: async (facts, next, env) => {
    const payload = facts['request.openaiResponses'];
    if (facts['request.delivery']?.transport !== 'websocket' || payload.generate !== false) return await next(facts);
    const now = env.clock();
    return {
      'response.http': { status: 200, statusText: '', headers: [], timing: { startedAt: now, headersAt: now }, body: null },
      'response.result': undefined,
      'response.openaiResponses': env.createStream({
        label: 'WebSocket warmup',
        iterate: () => syntheticEventsFromResult({
          id: '',
          object: 'response',
          model: payload.model,
          status: 'completed',
          output: [],
          error: null,
          incomplete_details: null,
          usage: { input_tokens: 0, output_tokens: 0, total_tokens: 0 },
        }),
      }),
      ...emptyUsageFacts(env),
    };
  },
});
