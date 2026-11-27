import { defineCopilotStage } from '../facts.ts';

export const stripClientHeaders = defineCopilotStage({
  name: 'copilot.stripClientHeaders',
  through: {
    request: { needs: ['http'], provides: ['http'], consumes: [] },
    response: { needs: [], provides: [], consumes: [] },
  },
  async execute(facts, scope) {
    return await scope.next({ ...facts, http: { ...facts.http, headers: [] } });
  },
});
