import { expect } from 'vitest';

import { record } from './fixtures.ts';
import { toKimiCodeUpstreamFacts, type KimiCodeUpstreamFacts } from '../src/config.ts';
import { kimiCodePipelines } from '../src/pipelines.ts';
import { createKimiCodeService, type KimiCodeServices } from '../src/service.ts';
import { run, type Pipeline, type RunEvent, type RunEventSink } from '@floway-dev/pipeline';
import { httpUrl, readHttpBody, toProviderModelFacts, type Fetcher, type ProtocolOutcome, type ProviderBaseOutput, type ProviderInput, type ProviderModel } from '@floway-dev/provider';
import { testFetcher } from '@floway-dev/test-utils';

export const kimiInput = <Payload>(model: ProviderModel, payload: Payload, upstream = record()): ProviderInput<KimiCodeUpstreamFacts, Payload> => ({
  'provider.upstream': toKimiCodeUpstreamFacts(upstream),
  'provider.model': toProviderModelFacts(model),
  'request.http': {
    method: 'POST',
    url: httpUrl('https://floway.example/inference'),
    headers: [
      ['x-inbound', 'client header'],
      ['content-type', 'text/plain'],
      ['anthropic-version', 'client version'],
      ['anthropic-beta', 'client beta'],
    ],
    body: null,
  },
  'request.payload': payload,
});

interface TestOptions {
  readonly fetcher?: Fetcher;
  readonly signal?: AbortSignal;
  readonly events?: RunEventSink;
  readonly kimiCode?: KimiCodeServices['kimiCode'];
}

export const runKimi = <In, Out>(
  pipeline: Pipeline<In, Out, KimiCodeServices>,
  facts: NoInfer<In>,
  { fetcher = testFetcher, signal, events, kimiCode = createKimiCodeService() }: TestOptions = {},
) => run(pipeline, facts, { services: { fetcher: () => fetcher, kimiCode }, finalizationTimeoutMs: 1_000, signal, events });

export const callKimi = async <In, Out extends ProviderBaseOutput>(
  pipeline: Pipeline<In, Out, KimiCodeServices>,
  facts: NoInfer<In>,
  options?: TestOptions,
) => {
  const handle = runKimi(pipeline, facts, options);
  const result = await handle.result;
  const body = await readHttpBody(result['response.http'].body);
  expect(await handle.done).toEqual({ ok: true });
  if (!body.ok) throw new Error(body.error.message, { cause: body.error });
  return { ...result, body: body.bytes };
};

const streamKimi = <In, Key extends string, Event, Result>(
  pipeline: Pipeline<In, ProviderBaseOutput & Readonly<Record<Key, ProtocolOutcome<Event, Result>>>, KimiCodeServices>,
  key: Key,
) => async (facts: In, options?: TestOptions) => {
  const handle = runKimi(pipeline, facts, options);
  const result = await handle.result;
  const outcome = result[key];
  if (outcome.kind !== 'stream') throw new Error(`Expected a Kimi Code stream, received ${outcome.kind}`);
  expect(result['response.http'].body).toBeNull();
  const frames = await Array.fromAsync(outcome.events);
  expect(await handle.done).toEqual({ ok: true });
  return { ...result, frames };
};

export const streamKimiChat = streamKimi(kimiCodePipelines.openaiChatCompletions, 'response.openaiChatCompletions');
export const streamKimiResponses = streamKimi(kimiCodePipelines.openaiResponses, 'response.openaiResponses');
export const streamKimiMessages = streamKimi(kimiCodePipelines.anthropicMessages, 'response.anthropicMessages');

export const probeSettlements = (events: readonly RunEvent[]) => events.flatMap(event => {
  if (event.k !== 'deferred' || !event.name.startsWith('kimiCode.')) return [];
  return [{
    name: event.name,
    settlement: events.find(candidate => candidate.k === 'settled' && candidate.deferredId === event.deferredId),
  }];
});
