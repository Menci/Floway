import { noopUpstreamCallOptions } from './stubs.ts';
import { exchangeResponse } from '@floway-dev/http/pipeline';
import { move, run, setRelease, type Handed, type RunServices } from '@floway-dev/pipeline';
import { providerModelFacts, type AnthropicMessagesUpstreamCallOptions, type ChatProviderOperation, type Provider, type ProviderChatResponse, type ProviderChatServices, type ProviderModel, type ProviderOperationOutputs, type ProviderOperationPayloads, type ProviderOperationRequest, type ProviderOperationResponse, type UpstreamCallOptions } from '@floway-dev/provider';

type Frame<O extends ChatProviderOperation> = Extract<ProviderOperationOutputs[O], { kind: 'stream' }> extends { frames: AsyncIterable<infer F> } ? F : never;

export const collectChatProviderPipeline = async <O extends ChatProviderOperation>(
  provider: Provider,
  operation: O,
  model: ProviderModel,
  payload: ProviderOperationPayloads[O],
  signal: AbortSignal | undefined = undefined,
  options: UpstreamCallOptions | AnthropicMessagesUpstreamCallOptions = noopUpstreamCallOptions(),
  observers: Pick<RunServices, 'log' | 'dump'> = {},
): Promise<{ facts: ProviderOperationResponse<O> & Record<string, unknown>; output: ProviderChatResponse<O>['response.provider.output']; frames: Frame<O>[]; response: Response | null }> => {
  const pipeline = provider.pipelines[operation];
  if (pipeline === undefined) throw new Error(`${provider.kind} has no ${operation} pipeline`);
  const entry = move({
    'request.provider.model': providerModelFacts(model),
    'request.provider.payload': payload,
    'request.http.callId': 0,
    'request.http.headers': [...options.headers],
    ...(operation === 'anthropicMessages' || operation === 'anthropicMessagesCountTokens' ? { 'request.provider.anthropicBeta': (options as AnthropicMessagesUpstreamCallOptions).anthropicBeta } : {}),
  }) as Handed<ProviderOperationRequest<O>>;
  const services: ProviderChatServices & Pick<RunServices, 'log' | 'dump'> = { ...observers, httpCall: () => ({ ...options, signal }), recordProtocolFrames: frames => frames };
  const executed = await run<ProviderOperationRequest<O>, ProviderOperationResponse<O>, ProviderChatServices>(pipeline, entry, services);
  const facts = executed.facts as ProviderOperationResponse<O> & Record<string, unknown>;
  const exchange = facts['response.http.exchange'];
  const output = facts['response.provider.output'] as ProviderChatResponse<O>['response.provider.output'];
  const frames: Frame<O>[] = [];
  let response: Response | null = null;
  try {
    if (exchange.type === 'transportFailure') throw exchange.error;
    if (output !== null && 'kind' in output && output.kind === 'stream') {
      for await (const frame of output.frames) frames.push(frame as Frame<O>);
      if (exchange.body !== null) setRelease(exchange.body, async () => {});
    } else if (output === null) {
      const raw = exchangeResponse(exchange);
      if (exchange.body !== null) setRelease(exchange.body, async () => {});
      const bytes = await raw.arrayBuffer();
      response = new Response(exchange.body === null ? null : bytes, { status: exchange.status, statusText: exchange.statusText, headers: exchange.headers.map(([name, value]): [string, string] => [name, value]) });
    }
  } catch (error) {
    try { await executed.drain(); } catch (cleanupError) {
      if (cleanupError !== error) throw new AggregateError([error, cleanupError], 'Provider test call and cleanup failed', { cause: error });
    }
    throw error;
  }
  await executed.drain();
  return { facts, output, frames, response };
};
