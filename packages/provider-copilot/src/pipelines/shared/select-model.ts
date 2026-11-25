import { defineCopilotStage } from '../facts.ts';
import { errorFact, parseCredentialFailure, type ProtocolResponseKey } from './authorize.ts';
import { move } from '@floway-dev/pipeline';
import type { ModelEndpointKey } from '@floway-dev/protocols/common';
import type { FormatProviderError } from '@floway-dev/provider';

export const selectModel = <const Key extends ProtocolResponseKey>(endpoint: ModelEndpointKey, key: Key, format: FormatProviderError<unknown>) => defineCopilotStage({
  name: `copilot.${endpoint}.selectModel`,
  through: {
    request: { needs: ['provider.upstream', 'provider.model'], provides: ['copilot.modelId'], consumes: [] },
    response: { needs: [], provides: [], consumes: [] },
  },
  return: { provides: ['response.http', 'response.modelKey', key] },
  async execute(facts, scope) {
    const upstreamId = facts['provider.upstream'].id;
    const model = facts['provider.model'].upstreamModelId;
    const selected = await scope.services.copilot.selectModel(upstreamId, model, endpoint, {});
    if (selected.kind === 'local') {
      const { http, outcome } = await parseCredentialFailure(selected, format);
      return { 'response.http': move(http), 'response.modelKey': model, ...errorFact(key, outcome) };
    }
    if (selected.kind !== 'model') throw new TypeError(`Copilot ${endpoint} unexpectedly rejected Fast Mode for ${model}`);
    return await scope.next({ ...facts, 'copilot.modelId': selected.id });
  },
});
