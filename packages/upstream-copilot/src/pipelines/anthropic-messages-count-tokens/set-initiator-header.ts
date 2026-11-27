import { initiatorHeaders } from '../anthropic-messages/set-initiator-header/shape.ts';
import { defineCopilotStage } from '../facts.ts';

export const setInitiatorHeader = defineCopilotStage({
  name: 'copilot.anthropicMessagesCountTokens.setInitiatorHeader',
  through: {
    request: { needs: ['anthropicMessagesCountTokens', 'http'], provides: ['http'], consumes: [] },
    response: { needs: [], provides: [], consumes: [] },
  },
  async execute(facts, scope) {
    const payload = facts.anthropicMessagesCountTokens;
    const headers = initiatorHeaders(payload, facts.http.headers);
    return await scope.next(headers === facts.http.headers ? facts : { ...facts, http: { ...facts.http, headers } });
  },
});
