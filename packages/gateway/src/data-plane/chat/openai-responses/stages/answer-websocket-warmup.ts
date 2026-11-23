import type { ResponsesBodyBack, ResponsesBodyFacts } from './facts.ts';
import { syntheticEventsFromResult } from '../items/output.ts';
import { defineStage } from '@floway-dev/pipeline';

// The first Codex WebSocket message prewarms the session. The response ID
// lets the next turn replay the stored input with previous_response_id.
// https://github.com/openai/codex/blob/6989c6548b3737f108e2bb5ae1171b1d2032e30c/codex-rs/core/src/client.rs#L2181-L2184

export const answerWebSocketWarmup = defineStage<ResponsesBodyFacts, ResponsesBodyFacts, ResponsesBodyBack, ResponsesBodyBack>({
  name: 'answerWebSocketWarmup',
  through: {
    request: { needs: ['request.openaiResponses'], consumes: [], provides: [] },
    response: { needs: [], consumes: [], provides: [] },
  },
  return: { provides: ['response.http', 'response.openaiResponses'] },
  execute: async (facts, scope) => {
    const payload = facts['request.openaiResponses'];
    if (!('request.ws.responseId' in facts) || payload.generate !== false) return await scope.next(facts);
    const now = scope.clock();
    const http = { status: 200, statusText: '', headers: [], timing: { startedAt: now, headersAt: now }, body: null };
    return {
      'response.http': http,
      'response.openaiResponses': {
        kind: 'stream', events: scope.createStream({
          label: 'WebSocket warmup',
          iterate: () => syntheticEventsFromResult({
            id: '',
            object: 'response',
            model: payload.model,
            status: 'completed',
            output: [],
            error: null,
            incomplete_details: null,
          }),
        }),
      },
    };
  },
});
