import { defineCopilotStage } from '../facts.ts';
import { setHeader } from '@floway-dev/http';

export const setIdentityHeaders = defineCopilotStage({
  name: 'copilot.setIdentityHeaders',
  through: {
    request: { needs: ['request.http'], provides: ['request.http'], consumes: [] },
    response: { needs: [], provides: [], consumes: [] },
  },
  async execute(facts, scope) {
    const http = facts['request.http'];
    const headers = scope.services.copilot.identityHeaders().reduce((lines, [name, value]) => setHeader(lines, name, value), http.headers);
    return await scope.next({ ...facts, 'request.http': { ...http, headers } });
  },
});
