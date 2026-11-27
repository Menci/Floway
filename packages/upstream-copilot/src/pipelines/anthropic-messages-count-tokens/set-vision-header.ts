import { visionHeaders } from '../anthropic-messages/set-vision-header/shape.ts';
import { defineCopilotStage } from '../facts.ts';

export const setVisionHeader = defineCopilotStage({
  name: 'copilot.anthropicMessagesCountTokens.setVisionHeader',
  through: {
    request: { needs: ['anthropicMessagesCountTokens', 'http'], provides: ['http'], consumes: [] },
    response: { needs: [], provides: [], consumes: [] },
  },
  async execute(facts, scope) {
    const payload = facts.anthropicMessagesCountTokens;
    const headers = visionHeaders(payload, facts.http.headers);
    return await scope.next(headers === facts.http.headers ? facts : { ...facts, http: { ...facts.http, headers } });
  },
});
