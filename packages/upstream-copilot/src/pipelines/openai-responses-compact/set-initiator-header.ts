import { defineCopilotStage } from '../facts.ts';
import { initiatorHeaders } from '../openai-responses/set-initiator-header/shape.ts';

export const setInitiatorHeader = defineCopilotStage({
  name: 'copilot.openaiResponsesCompact.setInitiatorHeader',
  through: {
    request: { needs: ['openaiResponsesCompact', 'http'], provides: ['http'], consumes: [] },
    response: { needs: [], provides: [], consumes: [] },
  },
  async execute(facts, scope) {
    const payload = facts.openaiResponsesCompact;
    const headers = initiatorHeaders(payload, facts.http.headers);
    return await scope.next(headers === facts.http.headers ? facts : { ...facts, http: { ...facts.http, headers } });
  },
});
