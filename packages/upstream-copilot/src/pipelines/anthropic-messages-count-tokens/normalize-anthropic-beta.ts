import { normalizedBetaHeaders } from '../anthropic-messages/normalize-anthropic-beta/shape.ts';
import { defineCopilotStage } from '../facts.ts';

export const normalizeAnthropicBeta = defineCopilotStage({
  name: 'copilot.anthropicMessagesCountTokens.normalizeAnthropicBeta',
  through: {
    request: { needs: ['anthropicMessagesCountTokens', 'http'], provides: ['http'], consumes: [] },
    response: { needs: [], provides: [], consumes: [] },
  },
  async execute(facts, scope) {
    const payload = facts.anthropicMessagesCountTokens;
    const headers = normalizedBetaHeaders(payload, facts.http.headers);
    return await scope.next(headers === facts.http.headers ? facts : { ...facts, http: { ...facts.http, headers } });
  },
});
