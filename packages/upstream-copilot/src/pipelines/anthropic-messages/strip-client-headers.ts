import { defineCopilotStage } from '../facts.ts';
import { filterHeaders } from '@floway-dev/http';

export const stripAnthropicMessagesClientHeaders = defineCopilotStage({
  name: 'copilot.anthropicMessages.stripClientHeaders',
  through: {
    request: { needs: ['http'], provides: ['http'], consumes: [] },
    response: { needs: [], provides: [], consumes: [] },
  },
  async execute(facts, scope) {
    const headers = filterHeaders(facts.http.headers, name => name === 'anthropic-beta');
    return await scope.next({ ...facts, http: { ...facts.http, headers } });
  },
});
