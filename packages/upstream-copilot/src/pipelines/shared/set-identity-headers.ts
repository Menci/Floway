import { copilotIdentityHeaders } from '../../auth.ts';
import { defineCopilotStage } from '../facts.ts';
import { setHeader } from '@floway-dev/http';

export const setIdentityHeaders = defineCopilotStage({
  name: 'copilot.setIdentityHeaders',
  through: {
    request: { needs: ['http'], provides: ['http'], consumes: [] },
    response: { needs: [], provides: [], consumes: [] },
  },
  async execute(facts, scope) {
    const headers = copilotIdentityHeaders().reduce((lines, [name, value]) => setHeader(lines, name, value), facts.http.headers);
    return await scope.next({ ...facts, http: { ...facts.http, headers } });
  },
});
