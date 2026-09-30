import { syntheticEventsFromResult } from './items/output.ts';
import type { OpenAIResponsesFacts } from './pipeline.ts';
import { telemetryModelIdentity } from '../../shared/telemetry/attribution.ts';
import type { ChatServices } from '../stages.ts';
import { defineStage, move } from '@floway-dev/pipeline';
import type { CanonicalOpenAIResponsesPayload, OpenAIResponsesResult } from '@floway-dev/protocols/openai-responses';
import { providerModelOf } from '@floway-dev/provider';

type Request = Pick<OpenAIResponsesFacts, 'request.chat.openaiResponses' | 'route.attempt'>;
type Response = Pick<OpenAIResponsesFacts, 'response.chat.openaiResponses' | 'response.chat.openaiResponses.streamedUsage' | 'response.usage.billable' | 'response.http.headers'>;
const provides = ['response.chat.openaiResponses', 'response.chat.openaiResponses.streamedUsage', 'response.usage.billable', 'response.http.headers'] as const;

// Codex continues from the response id of its WebSocket prewarm. The source chain has
// already staged its input; normal client egress commits that snapshot without inference.
// https://github.com/openai/codex/blob/6989c6548b3737f108e2bb5ae1171b1d2032e30c/codex-rs/core/src/client.rs#L2181-L2184
export const answerOpenAIResponsesWebSocketWarmup = defineStage<Request, Request, Response, Response, Response, ChatServices>({
  name: 'answerOpenAIResponsesWebSocketWarmup',
  through: {
    request: { needs: ['request.chat.openaiResponses', 'route.attempt'], consumes: [], provides: [] },
    response: { needs: provides, consumes: [], provides: [] },
  },
  return: { provides },
  execute: async (facts, next, use) => {
    const payload = facts['request.chat.openaiResponses'] as CanonicalOpenAIResponsesPayload;
    if (payload.generate !== false) return await next(facts);
    const candidate = use.resolveAttempt(facts['route.attempt']);
    use.selectAffinity(candidate);
    const response: OpenAIResponsesResult = {
      id: '', object: 'response', model: candidate.model.id, status: 'completed',
      output: [], error: null, incomplete_details: null,
      usage: { input_tokens: 0, output_tokens: 0, total_tokens: 0 },
    };
    return move({
      ...facts,
      'response.chat.openaiResponses': { kind: 'stream', frames: syntheticEventsFromResult(response) },
      'response.chat.openaiResponses.streamedUsage': null,
      'response.usage.billable': [{ identity: telemetryModelIdentity(candidate, providerModelOf(candidate).id), quantities: {} }],
      'response.http.headers': [],
    });
  },
});
