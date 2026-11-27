import { defineCopilotStage } from '../facts.ts';
import { normalizedBetaHeaders } from './normalize-anthropic-beta/shape.ts';
export { callerAnthropicBetas } from './normalize-anthropic-beta/shape.ts';

export const normalizeAnthropicBeta = defineCopilotStage({
  name: 'copilot.anthropicMessages.normalizeAnthropicBeta',
  through: {
    request: { needs: ['anthropicMessages', 'http'], provides: ['http'], consumes: [] },
    response: { needs: [], provides: [], consumes: [] },
  },
  async execute(facts, scope) {
    const payload = facts.anthropicMessages;
    const headers = normalizedBetaHeaders(payload, facts.http.headers);
    return await scope.next(headers === facts.http.headers ? facts : { ...facts, http: { ...facts.http, headers } });
  },
});
