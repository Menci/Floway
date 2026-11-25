import { defineCopilotStage } from '../facts.ts';
import type { ModelEndpointKey } from '@floway-dev/protocols/common';

export const selectModel = (endpoint: ModelEndpointKey) => defineCopilotStage({
  name: `copilot.${endpoint}.selectModel`,
  through: {
    request: { needs: ['provider.upstream', 'provider.model'], provides: ['copilot.modelId'], consumes: [] },
    response: { needs: [], provides: [], consumes: [] },
  },
  async execute(facts, scope) {
    const upstreamId = facts['provider.upstream'].id;
    const model = facts['provider.model'].upstreamModelId;
    const selected = await scope.services.copilot.selectModel(upstreamId, model, endpoint, {});
    if (selected.kind !== 'model') throw new TypeError(`Copilot ${endpoint} unexpectedly rejected Fast Mode for ${model}`);
    return await scope.next({ ...facts, 'copilot.modelId': selected.id });
  },
});
