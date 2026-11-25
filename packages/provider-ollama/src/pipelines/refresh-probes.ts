import { defineStage } from './facts.ts';

export const refreshProbes = defineStage({
  name: 'ollama.refresh-probes',
  through: {
    request: { needs: ['provider.upstream'], provides: [], consumes: [] },
    response: { needs: ['response.http'], provides: [], consumes: [] },
  },
  async execute(facts, scope) {
    const answer = await scope.next(facts);
    const { id, config: { cloudUsage, apiKey, configVersion } } = facts['provider.upstream'];
    if (!cloudUsage || apiKey === undefined || answer['response.http'] === null) return answer;
    scope.detach(async ({ services, log }) => {
      try {
        const fetch = services.fetcher(id);
        await services.ollama.refreshProbes(id, configVersion, async (url, init) => (await fetch(url, init)).response, (probe, error) => {
          log.withError(error).warn(`Ollama ${probe} refresh failed for ${id}`);
        });
      } catch (error) {
        log.withError(error).warn(`Ollama probe scheduling failed for ${id}`);
      }
    });
    return answer;
  },
});
