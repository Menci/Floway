import { defineStage } from './facts.ts';
import { providerBoundary } from '../shared/routing.ts';
import { azurePipelines } from '@floway-dev/upstream-azure';
import { copilotPipelines } from '@floway-dev/upstream-copilot';
import { customPipelines } from '@floway-dev/upstream-custom';
import { kimiCodePipelines } from '@floway-dev/upstream-kimi-code';
import { ollamaPipelines } from '@floway-dev/upstream-ollama';

const anthropic = providerBoundary('anthropicMessagesCountTokens');

export const anthropicMessagesCountTokensTargets = {
  azure: azurePipelines.anthropicMessagesCountTokens,
  copilot: copilotPipelines.anthropicMessagesCountTokens,
  custom: customPipelines.anthropicMessagesCountTokens,
  'kimi-code': kimiCodePipelines.anthropicMessagesCountTokens,
  ollama: ollamaPipelines.anthropicMessagesCountTokens,
};

export const routeAnthropicMessagesCountTokensProvider = defineStage({
  name: 'anthropicMessagesCountTokens.provider',
  request: { needs: anthropic.request.needs },
  into: { azure: anthropic, copilot: anthropic, custom: anthropic, 'kimi-code': anthropic, ollama: anthropic },
  async execute(facts, scope) {
    const kind = facts.upstream.kind;
    switch (kind) {
    case 'azure':
    case 'copilot':
    case 'custom':
    case 'kimi-code':
    case 'ollama':
      return await scope.into[kind](facts);
    default:
      throw new Error(`The ${kind} upstream has no Anthropic Messages count_tokens pipeline`);
    }
  },
});
