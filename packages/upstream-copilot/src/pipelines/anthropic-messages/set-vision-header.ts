import { defineCopilotStage } from '../facts.ts';
import { visionHeaders } from './set-vision-header/shape.ts';

export const setVisionHeader = defineCopilotStage({
  name: 'copilot.anthropicMessages.setVisionHeader',
  through: {
    request: { needs: ['anthropicMessages', 'http'], provides: ['http'], consumes: [] },
    response: { needs: [], provides: [], consumes: [] },
  },
  async execute(facts, scope) {
    const payload = facts.anthropicMessages;
    const headers = visionHeaders(payload, facts.http.headers);
    return await scope.next(headers === facts.http.headers ? facts : { ...facts, http: { ...facts.http, headers } });
  },
});
