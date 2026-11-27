import { defineStage } from './facts.ts';
import { providerBoundary } from '../shared/routing.ts';
import { azurePipelines } from '@floway-dev/upstream-azure';
import { copilotPipelines } from '@floway-dev/upstream-copilot';
import { customPipelines } from '@floway-dev/upstream-custom';
import { ollamaPipelines } from '@floway-dev/upstream-ollama';

export const targets = {
  azure: azurePipelines.decision,
  copilot: copilotPipelines.decision,
  custom: customPipelines.decision,
  ollama: ollamaPipelines.decision,
};

const boundary = providerBoundary('decision');

export const provider = defineStage({
  name: 'decision.provider',
  request: { needs: ['http', 'upstream', 'model', 'decision'] },
  into: { azure: boundary, copilot: boundary, custom: boundary, ollama: boundary },
  async execute(facts, scope) {
    const { kind } = facts.upstream;
    switch (kind) {
    case 'azure':
    case 'copilot':
    case 'custom':
    case 'ollama':
      return await scope.into[kind](facts);
    default:
      throw new Error(`The ${kind} upstream has no decision pipeline`);
    }
  },
});
