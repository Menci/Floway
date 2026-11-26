import { defineOperationStage } from './facts.ts';
import type { GatewayServices } from './services.ts';
import type { Pipeline } from '@floway-dev/pipeline';
import type { ProviderOperation, ProviderUpstream, UpstreamProviderKind } from '@floway-dev/provider';
import { azurePipelines } from '@floway-dev/provider-azure';
import { chatgptPipelines } from '@floway-dev/provider-chatgpt';
import { claudeCodePipelines } from '@floway-dev/provider-claude-code';
import { copilotPipelines } from '@floway-dev/provider-copilot';
import { customPipelines } from '@floway-dev/provider-custom';
import { kimiCodePipelines } from '@floway-dev/provider-kimi-code';
import { ollamaPipelines } from '@floway-dev/provider-ollama';

type ProviderOperations = Partial<Record<ProviderOperation, Pipeline<never, unknown, GatewayServices>>>;

const pipelines: Record<UpstreamProviderKind, ProviderOperations> = {
  azure: azurePipelines,
  chatgpt: chatgptPipelines,
  'claude-code': claudeCodePipelines,
  copilot: copilotPipelines,
  custom: customPipelines,
  'kimi-code': kimiCodePipelines,
  ollama: ollamaPipelines,
};

export const providerTargets = (operation: ProviderOperation) => {
  const request = ['request.http', 'provider.model', 'provider.upstream', `request.${operation}`];
  const response = ['response.http', `response.${operation}`];
  const targets = Object.fromEntries(Object.entries(pipelines).flatMap(([kind, operations]) => {
    const target = operations[operation];
    return target ? [[kind, target] as const] : [];
  }));
  const declaration = {
    request: { needs: request, provides: [], consumes: [] },
    response: { needs: response, provides: [], consumes: [] },
  };
  const ending = defineOperationStage({
    name: `${operation}.provider`,
    request: { needs: request },
    into: Object.fromEntries(Object.keys(targets).map(kind => [kind, declaration])),
    async execute(facts, scope) {
      const { kind } = facts['provider.upstream'] as ProviderUpstream;
      const enter = scope.into[kind];
      if (!enter) throw new Error(`The ${kind} provider has no ${operation} pipeline`);
      return await enter(facts);
    },
  });
  return { targets, ending };
};
