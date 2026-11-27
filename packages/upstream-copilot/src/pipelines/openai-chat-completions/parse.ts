import { defineCopilotStage } from '../facts.ts';
import { formatOpenAIError } from '../shared/format-errors.ts';
import { ERROR_BODY_BYTES } from '../shared/wire-request.ts';
import { decodeOpenAIChatCompletionsStream } from '@floway-dev/protocols/openai-chat-completions';
import { parseUpstreamStream } from '@floway-dev/upstream';

export const parse = defineCopilotStage({
  name: 'copilot.openaiChatCompletions.parse',
  through: {
    request: { needs: [], provides: [], consumes: [] },
    response: { needs: ['http', 'openaiChatCompletions?'], provides: ['http', 'openaiChatCompletions'], consumes: [] },
  },
  async execute(facts, scope) {
    const back = await scope.next(facts);
    const { http, openaiChatCompletions: outcome } = back;
    if (outcome !== undefined) return { ...back, openaiChatCompletions: outcome };
    if (http === null) throw new Error('Copilot openaiChatCompletions has neither an HTTP response nor an outcome');
    const parsed = await parseUpstreamStream(http, scope, decodeOpenAIChatCompletionsStream, formatOpenAIError, ERROR_BODY_BYTES);
    return { ...back, http: parsed.http, openaiChatCompletions: parsed.outcome };
  },
});
