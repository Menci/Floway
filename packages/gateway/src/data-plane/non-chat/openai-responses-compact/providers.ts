import { defineStage } from './facts.ts';
import { providerBoundary } from '../shared/routing.ts';
import { azurePipelines } from '@floway-dev/upstream-azure';
import { chatgptPipelines } from '@floway-dev/upstream-chatgpt';
import { copilotPipelines } from '@floway-dev/upstream-copilot';
import { customPipelines } from '@floway-dev/upstream-custom';
import { ollamaPipelines } from '@floway-dev/upstream-ollama';

const boundary = providerBoundary('openaiResponsesCompact');

export const openaiResponsesCompactTargets = {
  azure: azurePipelines.openaiResponsesCompact,
  chatgpt: chatgptPipelines.openaiResponsesCompact,
  copilot: copilotPipelines.openaiResponsesCompact,
  custom: customPipelines.openaiResponsesCompact,
  ollama: ollamaPipelines.openaiResponsesCompact,
};

export const routeOpenAIResponsesCompactProvider = defineStage({
  name: 'openaiResponsesCompact.provider',
  request: { needs: boundary.request.needs },
  into: { azure: boundary, chatgpt: boundary, copilot: boundary, custom: boundary, ollama: boundary },
  async execute(facts, scope) {
    const kind = facts.upstream.kind;
    switch (kind) {
    case 'azure':
    case 'chatgpt':
    case 'copilot':
    case 'custom':
    case 'ollama':
      return await scope.into[kind](facts);
    default:
      throw new Error(`The ${kind} upstream has no OpenAI Responses compact pipeline`);
    }
  },
});
