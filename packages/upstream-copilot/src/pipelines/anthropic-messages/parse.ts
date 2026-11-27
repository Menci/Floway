import { defineCopilotStage } from '../facts.ts';
import { formatAnthropicMessagesError } from '../shared/format-errors.ts';
import { ERROR_BODY_BYTES } from '../shared/wire-request.ts';
import { decodeAnthropicMessagesStream } from '@floway-dev/protocols/anthropic-messages';
import { parseUpstreamStream } from '@floway-dev/upstream';

export const parse = defineCopilotStage({
  name: 'copilot.anthropicMessages.parse',
  through: {
    request: { needs: [], provides: [], consumes: [] },
    response: { needs: ['http', 'anthropicMessages?'], provides: ['http', 'anthropicMessages'], consumes: [] },
  },
  async execute(facts, scope) {
    const back = await scope.next(facts);
    const { http, anthropicMessages: outcome } = back;
    if (outcome !== undefined) return { ...back, anthropicMessages: outcome };
    if (http === null) throw new Error('Copilot anthropicMessages has neither an HTTP response nor an outcome');
    const parsed = await parseUpstreamStream(http, scope, decodeAnthropicMessagesStream, formatAnthropicMessagesError, ERROR_BODY_BYTES);
    return { ...back, http: parsed.http, anthropicMessages: parsed.outcome };
  },
});
