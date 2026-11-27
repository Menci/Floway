import { defineCopilotStage } from '../facts.ts';
import { visionHeaders } from '../openai-responses/set-vision-header/shape.ts';

export const setVisionHeader = defineCopilotStage({
  name: 'copilot.openaiResponsesCompact.setVisionHeader',
  through: {
    request: { needs: ['openaiResponsesCompact', 'http'], provides: ['http'], consumes: [] },
    response: { needs: [], provides: [], consumes: [] },
  },
  async execute(facts, scope) {
    const payload = facts.openaiResponsesCompact;
    const headers = visionHeaders(payload, facts.http.headers);
    return await scope.next(headers === facts.http.headers ? facts : { ...facts, http: { ...facts.http, headers } });
  },
});
