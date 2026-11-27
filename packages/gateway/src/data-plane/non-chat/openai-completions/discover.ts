import { openaiCompletionsTargets } from './provider.ts';
import { discoverCandidates } from '../../pipeline/discover-candidates.ts';
import { defineStage } from '../../pipeline/facts.ts';
import { localHead, openAIError } from '../shared/http.ts';
import { unavailableModel } from '../shared/routing.ts';

const endpoint = '/completions';

export const discoverOpenAICompletions = defineStage({
  name: 'openaiCompletions.discover',
  through: {
    request: { needs: ['serve.startedAt', 'openaiCompletions'], provides: ['candidates'], consumes: [] },
    response: { needs: [], provides: [], consumes: [] },
  },
  return: { provides: ['http', 'openaiCompletions'] },
  async execute(facts, scope) {
    const payload = facts.openaiCompletions;
    const model = payload.model;
    const { candidates, exists } = await discoverCandidates(scope.services, {
      model,
      kind: 'chat',
      payload,
      supports: candidate => candidate.model.endpoints.openaiCompletions !== undefined
        && Object.hasOwn(openaiCompletionsTargets, candidate.upstream.kind),
    });
    if (candidates.length > 0) return await scope.next({ ...facts, candidates });
    return {
      http: localHead(exists ? 400 : 404),
      openaiCompletions: { kind: 'error', source: 'local', error: openAIError(unavailableModel(model, endpoint, exists)) },
    };
  },
});
