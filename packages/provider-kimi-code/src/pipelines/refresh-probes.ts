import { defineStage } from './facts.ts';

export const refreshProbes = defineStage({
  name: 'kimi-code.refresh-probes',
  through: {
    request: { needs: ['provider.upstream'], provides: [], consumes: [] },
    response: { needs: ['response.http'], provides: [], consumes: [] },
  },
  async execute(facts, scope) {
    const answer = await scope.next(facts);
    const http = answer['response.http'];
    if (http === null) return answer;
    const { id, config: { configVersion } } = facts['provider.upstream'];
    // Permission and quota failures warrant a fresh usage read.
    // https://www.kimi.com/code/docs/en/kimi-code/error-reference.html
    const forceUsage = http.status === 403 || http.status === 429;
    scope.detach(async ({ services, log }) => {
      try {
        const fetch = services.fetcher(id);
        await services.kimiCode.refreshProbes(id, configVersion, async (url, init) => (await fetch(url, init)).response, forceUsage, (probe, error) => {
          log.withError(error).warn(`Kimi Code ${probe} refresh failed for ${id}`);
        });
      } catch (error) {
        log.withError(error).warn(`Kimi Code probe scheduling failed for ${id}`);
      }
    });
    return answer;
  },
});
