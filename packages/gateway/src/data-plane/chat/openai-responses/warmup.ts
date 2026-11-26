import { syntheticEventsFromResult } from './items/output.ts';
import { defineOpenAIResponsesStage } from './pipeline-facts.ts';
import { localResponseHead } from '../../pipeline/encode.ts';
import type { Result } from '@floway-dev/pipeline';
import type { OpenAIResponsesStreamEventEx } from '@floway-dev/protocols/openai-responses';
import type { ProtocolStreamError } from '@floway-dev/provider';

// Codex continues from the empty response's ID after the session prewarm.
// https://github.com/openai/codex/blob/6989c6548b3737f108e2bb5ae1171b1d2032e30c/codex-rs/core/src/client.rs#L2181-L2184
export const answerOpenAIResponsesWebSocketWarmup = defineOpenAIResponsesStage({
  name: 'openaiResponses.answer-websocket-warmup',
  through: {
    request: { needs: ['request.openaiResponses', 'request.ws.responseId?', 'provider.model'], provides: [], consumes: [] },
    response: { needs: [], provides: [], consumes: [] },
  },
  return: { provides: ['response.http', 'response.openaiResponses'] },
  async execute(facts, scope) {
    const request = facts['request.openaiResponses'];
    const id = facts['request.ws.responseId'];
    if (id === undefined || request.generate !== false) return await scope.next(facts);

    const stream = scope.createStream(async function* (): AsyncGenerator<Result<OpenAIResponsesStreamEventEx, ProtocolStreamError>> {
      for await (const frame of syntheticEventsFromResult({
        id,
        object: 'response',
        model: facts['provider.model'].id,
        status: 'completed',
        output: [],
        error: null,
        incomplete_details: null,
        usage: { input_tokens: 0, output_tokens: 0, total_tokens: 0 },
      })) {
        if (frame.type === 'event') yield { ok: true, value: frame.event };
      }
    });
    return {
      'response.http': { ...localResponseHead(200), body: null },
      'response.openaiResponses': { kind: 'stream', stream },
    };
  },
});
