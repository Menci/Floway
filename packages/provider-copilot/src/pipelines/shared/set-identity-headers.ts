import { defineCopilotStage } from '../facts.ts';
import { move, transform } from '@floway-dev/pipeline';

export const setIdentityHeaders = defineCopilotStage({
  name: 'copilot.setIdentityHeaders',
  through: {
    request: { needs: ['request.http'], provides: ['request.http'], consumes: [] },
    response: { needs: [], provides: [], consumes: [] },
  },
  execute: transform(scope => ({
    request(facts) {
      const request = facts['request.http'];
      return {
        ...facts,
        'request.http': move({ ...request, headers: [...request.headers, ...scope.services.copilot.identityHeaders()] }),
      };
    },
  })),
});
