import { expect } from 'vitest';

import { run, type ManagedStream, type Pipeline, type RunEventSink } from '@floway-dev/pipeline';
import { readHttpBody, toProviderModelFacts, type Fetcher, type ProviderHttpOutput, type ProviderInput, type ProviderModel, type ProviderServices, type ProviderStreamOutput } from '@floway-dev/provider';
import { assertExists, testFetcher } from '@floway-dev/test-utils';

export const kimiInput = <Payload>(model: ProviderModel, payload: Payload): ProviderInput<Payload> => ({
  'provider.model': toProviderModelFacts(model),
  'request.headers': [],
  'request.payload': payload,
});

interface TestOptions {
  readonly fetcher?: Fetcher;
  readonly signal?: AbortSignal;
  readonly events?: RunEventSink;
}

export const runKimi = <In, Out>(
  pipeline: Pipeline<In, Out, ProviderServices> | undefined,
  facts: NoInfer<In>,
  { fetcher = testFetcher, signal, events }: TestOptions = {},
) => {
  assertExists(pipeline);
  return run(pipeline, facts, { services: { fetcher: () => fetcher }, finalizationTimeoutMs: 1_000, signal, events });
};

export const callKimi = async <In, Out extends ProviderHttpOutput & { 'response.events'?: ManagedStream<unknown> | undefined }>(
  pipeline: Pipeline<In, Out, ProviderServices> | undefined,
  facts: NoInfer<In>,
  options?: TestOptions,
) => {
  const handle = runKimi(pipeline, facts, options);
  const result = await handle.result;
  const body = await readHttpBody(result['response.http'].body);
  await result['response.events']?.close();
  expect(await handle.done).toEqual({ ok: true });
  return { ...result, body };
};

export const streamKimi = async <In, Event>(
  pipeline: Pipeline<In, ProviderStreamOutput<Event>, ProviderServices> | undefined,
  facts: NoInfer<In>,
  options?: TestOptions,
) => {
  const handle = runKimi(pipeline, facts, options);
  const result = await handle.result;
  const events = result['response.events'];
  assertExists(events);
  expect(result['response.http'].body).toBeNull();
  const frames = await Array.fromAsync(events);
  expect(await handle.done).toEqual({ ok: true });
  return { ...result, frames };
};
