import { noopUpstreamCallOptions } from './stubs.ts';
import { exchangeResponse } from '@floway-dev/http/pipeline';
import { move, run, setRelease } from '@floway-dev/pipeline';
import type { ProtocolFrame } from '@floway-dev/protocols/common';
import {
  providerModelFacts, type AnthropicMessagesUpstreamCallOptions, type ChatProviderOperation,
  type Provider, type ProviderChatServices, type ProviderModel, type ProviderOperationOutputs,
  type ProviderOperationPayloads, type ProviderOperationRequest, type UpstreamCallOptions,
} from '@floway-dev/provider';

type FrameStream<O extends ChatProviderOperation> = Extract<ProviderOperationOutputs[O], { kind: 'stream' }>['frames'];
type Decoded<O extends ChatProviderOperation> = Extract<ProviderOperationOutputs[O], { kind: 'value' }>['body'];
type Result<O extends ChatProviderOperation> = { readonly modelKey: string; readonly http: Response }
  & ({ readonly ok: false } | { readonly ok: true; readonly events: FrameStream<O> } | { readonly ok: true; readonly result: Decoded<O> });

export const callProviderChatPipeline = async <O extends ChatProviderOperation>(
  provider: Provider,
  operation: O,
  model: ProviderModel,
  payload: ProviderOperationPayloads[O],
  signal: AbortSignal | undefined = undefined,
  options: UpstreamCallOptions | AnthropicMessagesUpstreamCallOptions = noopUpstreamCallOptions(),
): Promise<Result<O>> => {
  const pipeline = provider.pipelines[operation];
  if (pipeline === undefined) throw new Error(`${provider.kind} has no ${operation} pipeline`);
  const entry = move({
    'request.provider.model': providerModelFacts(model),
    'request.provider.payload': payload,
    'request.http.callId': 0,
    'request.http.headers': [...options.headers],
    ...(operation === 'anthropicMessages' || operation === 'anthropicMessagesCountTokens'
      ? { 'request.provider.anthropicBeta': 'anthropicBeta' in options ? options.anthropicBeta : [] }
      : {}),
  }) as ProviderOperationRequest<O>;
  const services: ProviderChatServices = { httpCall: () => ({ ...options, signal }), recordProtocolFrames: frames => frames };
  const executed = await run(pipeline, entry, services);
  const exchange = executed.facts['response.http.exchange'];
  try {
    if (exchange.type === 'transportFailure') throw exchange.error;
    const output = executed.facts['response.provider.output'];
    const modelKey = executed.facts['response.provider.modelKey'];
    const init = { status: exchange.status, headers: new Headers(exchange.headers.map(([key, value]): [string, string] => [key, value])) };
    if (exchange.body !== null) setRelease(exchange.body, async () => {});
    if (output !== null && 'kind' in output) {
      if (output.kind === 'value') {
        return { ok: true, modelKey, http: Response.json(output.body, init), result: output.body as Decoded<O> };
      }
      const observed: ProtocolFrame<unknown>[] = [];
      for await (const frame of output.frames) observed.push(frame);
      const events = { async *[Symbol.asyncIterator]() { yield* observed; } } as FrameStream<O>;
      return { ok: true, modelKey, http: new Response(null, init), events };
    }
    if (output !== null) {
      return { ok: false, modelKey, http: Response.json(output.body ?? { error: { message: output.message } }, { ...init, status: output.status }) };
    }
    return { ok: false, modelKey, http: new Response(exchange.body === null ? null : await exchangeResponse(exchange).arrayBuffer(), init) };
  } finally {
    await executed.drain();
  }
};
