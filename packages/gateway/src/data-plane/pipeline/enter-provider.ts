import { gatewayFactSpace } from './facts.ts';
import { providerTargets } from './provider-pipelines.ts';
import type { GatewayServices } from './services.ts';
import { move } from '@floway-dev/pipeline';
import type { ProviderOperation } from '@floway-dev/provider';

const { defineStage } = gatewayFactSpace<GatewayServices>();

const operationProtocols = {
  anthropicMessagesCountTokens: 'anthropicMessages',
  geminiGenerateContentCountTokens: 'geminiGenerateContent',
  openaiResponsesCompact: 'openaiResponses',
} as const;

type OperationProtocol<Operation extends ProviderOperation> = Operation extends keyof typeof operationProtocols
  ? typeof operationProtocols[Operation]
  : Operation;

export const enterProvider = (operation: ProviderOperation) => {
  const protocols: Partial<Record<ProviderOperation, string>> = operationProtocols;
  const protocol = (protocols[operation] ?? operation) as OperationProtocol<ProviderOperation>;
  const requestKey = `request.${protocol}` as const;
  const responseKey = `response.${protocol}` as const;
  const targets = providerTargets(operation);
  const declaration = {
    request: { needs: ['request.http', requestKey], provides: ['provider.upstream', 'provider.model'], consumes: [] },
    response: { needs: ['response.http', 'response.modelKey', responseKey], provides: [], consumes: [] },
  } as const;
  const into: Readonly<Record<string, typeof declaration>> = Object.fromEntries(Object.keys(targets).map(kind => [kind, declaration]));

  const ending = defineStage({
    name: 'serve.enter-provider',
    request: { needs: ['request.http', requestKey, 'serve.candidate'] },
    into,
    async execute(facts, scope) {
      const { upstream, model } = facts['serve.candidate'];
      const call = scope.into[upstream.kind];
      if (call === undefined) {
        throw new TypeError(`The ${upstream.kind} provider has no ${operation} pipeline for ${upstream.id}`);
      }
      return await call({
        ...facts,
        'provider.upstream': move(upstream),
        'provider.model': move(model),
      });
    },
  });
  return { ending, targets };
};
