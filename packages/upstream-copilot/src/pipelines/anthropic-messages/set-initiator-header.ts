import { defineCopilotStage } from '../facts.ts';
import { initiatorHeaders } from './set-initiator-header/shape.ts';

export const setInitiatorHeader = defineCopilotStage({
  name: 'copilot.anthropicMessages.setInitiatorHeader',
  through: {
    request: { needs: ['anthropicMessages', 'http'], provides: ['http'], consumes: [] },
    response: { needs: [], provides: [], consumes: [] },
  },
  async execute(facts, scope) {
    const payload = facts.anthropicMessages;
    const headers = initiatorHeaders(payload, facts.http.headers);
    return await scope.next(headers === facts.http.headers ? facts : { ...facts, http: { ...facts.http, headers } });
  },
});
