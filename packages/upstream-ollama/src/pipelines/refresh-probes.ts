import { isOllamaUsageEnabled } from '../usage-probe.ts';
import { defineStage } from './facts.ts';
import { ollamaTarget } from './request.ts';

export const refreshProbes = defineStage({
  name: 'ollama.refresh-probes',
  through: {
    request: { needs: ['upstream'], provides: [], consumes: [] },
    response: { needs: ['http'], provides: [], consumes: [] },
  },
  async execute(facts, scope) {
    const answer = await scope.next(facts);
    if (answer.http === null) return answer;
    const upstream = ollamaTarget(facts.upstream);
    if (!isOllamaUsageEnabled(upstream.config)) return answer;
    for (const method of ['refreshUsage', 'refreshAccount'] as const) {
      scope.detach(async ({ services, log }) => {
        try {
          await services.ollama[method](upstream, services.fetcher(upstream.id));
        } catch (error) {
          log.withError(error).warn('Ollama active probe failed', { upstreamId: upstream.id, method });
          throw error;
        }
      });
    }
    return answer;
  },
});
