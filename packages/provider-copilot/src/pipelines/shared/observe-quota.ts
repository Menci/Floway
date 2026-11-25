import { defineCopilotStage } from '../facts.ts';

export const observeQuota = defineCopilotStage({
  name: 'copilot.observeQuota',
  through: {
    request: { needs: ['provider.upstream'], provides: [], consumes: [] },
    response: { needs: ['response.http'], provides: [], consumes: [] },
  },
  async execute(facts, scope) {
    const { id } = facts['provider.upstream'];
    const back = await scope.next(facts);
    const http = back['response.http'];
    if (http !== null) {
      scope.defer(scope.services.copilot.observeQuota(id, http.headers).then(result => {
        if (!result.ok) scope.log.withField('upstream', id).withField('error', result.error).warn('Failed to capture Copilot quota snapshot');
      }));
    }
    return back;
  },
});
