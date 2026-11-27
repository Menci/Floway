import { defineStage } from './facts.ts';
import { kimiCodeConfig } from './request.ts';

export const refreshProbes = defineStage({
  name: 'kimi-code.refresh-probes',
  through: {
    request: { needs: ['upstream'], provides: [], consumes: [] },
    response: { needs: ['http'], provides: [], consumes: [] },
  },
  async execute(facts, scope) {
    const answer = await scope.next(facts);
    if (answer.http === null) return answer;
    const id = facts.upstream.id;
    const config = kimiCodeConfig(facts.upstream);
    // Permission and quota failures warrant a fresh usage read.
    // https://www.kimi.com/code/docs/en/kimi-code/error-reference.html
    const forceUsage = answer.http.status === 403 || answer.http.status === 429;
    scope.detach(async ({ services, log }) => {
      try {
        await services.kimiCode.refreshProbes(id, config, services.fetcher(id), forceUsage);
      } catch (error) {
        log.withError(error).warn(`Kimi Code probe refresh failed for ${id}`);
        throw error;
      }
    });
    return answer;
  },
});
