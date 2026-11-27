import { selectCountTokensCandidates, supportsAnthropicMessagesCountTokens } from './candidates.ts';
import { defineStage } from './facts.ts';
import { analyzeAnthropicMessagesAffinity } from '../../chat/anthropic-messages/affinity/ingress.ts';
import { discoverCandidates } from '../../pipeline/discover-candidates.ts';
import { localHead } from '../shared/http.ts';
import { unavailableModel } from '../shared/routing.ts';
import { generateAnthropicId } from '@floway-dev/protocols/anthropic-messages';

export const discoverAnthropicMessagesCountTokensCandidates = defineStage({
  name: 'anthropicMessagesCountTokens.discover-candidates',
  through: {
    request: {
      needs: ['anthropicMessagesCountTokens', 'requestedModel'],
      provides: ['anthropicMessagesCountTokensTargets'],
      consumes: ['anthropicMessagesCountTokens', 'requestedModel'],
    },
    response: { needs: [], provides: [], consumes: [] },
  },
  return: { provides: ['http', 'anthropicMessagesCountTokens'] },
  async execute({ anthropicMessagesCountTokens: payload, requestedModel, ...facts }, scope) {
    const failed = (status: 400 | 404, message: string) => ({
      http: localHead(status),
      anthropicMessagesCountTokens: {
        kind: 'error' as const,
        source: 'local' as const,
        error: {
          type: 'error',
          error: { type: status === 400 ? 'invalid_request_error' : 'not_found_error', message },
          request_id: generateAnthropicId('req'),
        },
      },
    });
    const { candidates, exists } = await discoverCandidates(scope.services, {
      kind: 'chat', model: requestedModel, payload, supports: supportsAnthropicMessagesCountTokens,
    });
    const affinity = await analyzeAnthropicMessagesAffinity(payload, scope.services.affinity);
    const selection = selectCountTokensCandidates(candidates, affinity);
    if ('kind' in selection) return failed(400, selection.message);
    if (selection.length === 0) return failed(exists ? 400 : 404, unavailableModel(requestedModel, '/messages/count_tokens', exists));
    return await scope.next({ ...facts, anthropicMessagesCountTokensTargets: selection });
  },
});
