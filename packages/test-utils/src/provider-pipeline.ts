import { noopUpstreamCallOptions } from './stubs.ts';
import { exchangeResponse, type HttpServices } from '@floway-dev/http/pipeline';
import { move, run, setRelease } from '@floway-dev/pipeline';
import type { NonChatProviderOperation, Provider, ProviderCallResult, ProviderModel, ProviderOperationPayloads, ProviderOperationResponse, ProviderPipeline, ProviderRerankCallResult, ProviderOperationRequest, UpstreamCallOptions } from '@floway-dev/provider';
import { providerModelFacts } from '@floway-dev/provider';

type CallResult<O extends NonChatProviderOperation> =
  (O extends 'rerank' ? ProviderRerankCallResult : ProviderCallResult) & { readonly called: boolean; readonly previousCalls: readonly { readonly modelKey: string }[] };

export const callProviderPipeline = async <O extends NonChatProviderOperation>(
  provider: Provider,
  operation: O,
  model: ProviderModel,
  payload: ProviderOperationPayloads[O],
  signal: AbortSignal | undefined = undefined,
  options: UpstreamCallOptions = noopUpstreamCallOptions(),
): Promise<CallResult<O>> => {
  const pipeline = provider.pipelines[operation];
  if (pipeline === undefined) throw new Error(`${provider.kind} has no ${operation} pipeline`);
  const entry = move({
    'request.provider.model': providerModelFacts(model),
    'request.provider.payload': payload,
    'request.http.callId': 0,
    'request.http.headers': [...options.headers],
  }) as ProviderOperationRequest<O>;
  const services: HttpServices = { httpCall: () => ({ ...options, signal }) };
  const executed = await run<ProviderOperationRequest<O>, ProviderOperationResponse<O>, HttpServices>(pipeline as ProviderPipeline<O>, entry, services);
  const facts = executed.facts;
  const exchange = facts['response.http.exchange'];
  if (exchange.type === 'transportFailure') {
    await executed.drain();
    throw exchange.error;
  }
  const response = exchangeResponse(exchange);
  let bytes: ArrayBuffer;
  try {
    bytes = await response.arrayBuffer();
    if (exchange.body !== null) setRelease(exchange.body, async () => {});
  } finally {
    await executed.drain();
  }
  const result = {
    response: new Response(exchange.body === null ? null : bytes, { status: exchange.status, statusText: exchange.statusText, headers: response.headers }),
    modelKey: facts['response.provider.modelKey'],
    called: facts['response.provider.called'],
    previousCalls: facts['response.provider.previousCalls'],
    ...(operation === 'rerank' ? { target: (facts as ProviderOperationResponse<'rerank'>)['response.provider.rerankTarget'] } : {}),
  };
  return result as CallResult<O>;
};
