import { localChatHead } from '../../pipeline/encode.ts';
import { defineStage } from '../../pipeline/facts.ts';
import { syntheticEventsFromResult } from '../items/output.ts';
import type { Result } from '@floway-dev/pipeline';
import type { OpenAIResponsesStreamEventEx } from '@floway-dev/protocols/openai-responses';
import type { ProtocolStreamError } from '@floway-dev/upstream';

// The WebSocket client continues from the empty response's ID after prewarm.
// https://github.com/openai/codex/blob/6989c6548b3737f108e2bb5ae1171b1d2032e30c/codex-rs/core/src/client.rs#L2181-L2184
export const answerOpenAIResponsesWebSocketWarmup = defineStage({
  name: 'openaiResponses.answer-websocket-warmup',
  through: {
    request: { needs: ['openaiResponses', 'ws.message?', 'ws.responseId?', 'model'], provides: [], consumes: [] },
    response: { needs: [], provides: [], consumes: [] },
  },
  return: { provides: ['http', 'openaiResponses'] },
  async execute(facts, scope) {
    const payload = facts.openaiResponses;
    if (facts['ws.message'] === undefined || payload.generate !== false) return await scope.next(facts);
    const stream = scope.createStream(async function* (): AsyncGenerator<Result<OpenAIResponsesStreamEventEx, ProtocolStreamError>> {
      for await (const frame of syntheticEventsFromResult({
        id: facts['ws.responseId'] ?? '',
        object: 'response',
        model: facts.model.id,
        status: 'completed',
        output: [],
        error: null,
        incomplete_details: null,
        usage: { input_tokens: 0, output_tokens: 0, total_tokens: 0 },
      })) {
        if (frame.type === 'event') yield { ok: true, value: frame.event };
      }
    });
    return { http: localChatHead(200), openaiResponses: { kind: 'stream', stream } };
  },
});
