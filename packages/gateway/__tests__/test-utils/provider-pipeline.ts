import type { GatewayCtx } from '../../src/data-plane/shared/gateway-ctx.ts';
import { takeHttpResponse } from '@floway-dev/http/pipeline';
import { compose, defineStage, isSecret, move, type Pipeline } from '@floway-dev/pipeline';
import { directFetcher, identityWrapUpstreamCall, type ProviderCallResult, type ProviderModelFacts, type ProviderOperation, type ProviderOperationPayloads, type ProviderResponse, type ProviderRerankResponse, type ProviderRequest, type UpstreamCallOptions } from '@floway-dev/provider';

export const stubProviderPipeline = <O extends ProviderOperation>(
  operation: O,
  call: (model: ProviderModelFacts, payload: ProviderOperationPayloads[O], signal: AbortSignal | undefined, options: UpstreamCallOptions) => Promise<ProviderCallResult>,
): Pipeline<ProviderRequest<ProviderOperationPayloads[O]>, O extends 'rerank' ? ProviderRerankResponse : ProviderResponse> => compose<ProviderRequest<ProviderOperationPayloads[O]>, ProviderResponse>(`stub.${operation}`, [
  defineStage<ProviderRequest<ProviderOperationPayloads[O]>, ProviderResponse, { gateway: GatewayCtx }>({
    name: 'stubHttp',
    return: { provides: ['response.http.exchange', 'response.http.body', 'response.provider.modelKey', 'response.provider.called', 'response.provider.previousCalls'] },
    execute: async (facts, use) => {
      let result: ProviderCallResult;
      // The fixture callback stands for the transport, so its rejection is a transport outcome.
      try {
        result = await call(facts['request.provider.model'], facts['request.provider.payload'], use.gateway.abortSignal, {
          fetcher: directFetcher, waitUntil: use.gateway.backgroundScheduler, wrapUpstreamCall: identityWrapUpstreamCall,
          headers: new Headers(facts['request.http.headers'].map(([name, value]): [string, string] => [name, isSecret(value) ? value.reveal() : value])),
        });
      } catch (error) {
        return move({
          ...facts, 'response.http.exchange': { type: 'transportFailure', error }, 'response.http.body': null,
          'response.provider.modelKey': facts['request.provider.model'].id, 'response.provider.called': false, 'response.provider.previousCalls': [],
        });
      }
      const exchange = takeHttpResponse(result.response);
      return move({
        ...facts, 'response.http.exchange': exchange, 'response.http.body': exchange.body,
        'response.provider.modelKey': result.modelKey, 'response.provider.called': true, 'response.provider.previousCalls': [],
        ...('target' in result ? { 'response.provider.rerankTarget': result.target } : {}),
      });
    },
  }),
]) as Pipeline<ProviderRequest<ProviderOperationPayloads[O]>, O extends 'rerank' ? ProviderRerankResponse : ProviderResponse>;
