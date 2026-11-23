import { expect } from 'vitest';

import { run, type ManagedStream, type Pipeline, type RunEventSink } from '@floway-dev/pipeline';
import { directFetcher, readHttpBody, toProviderModelFacts, type Fetcher, type HeaderEntry, type ProviderHttpOutput, type ProviderInput, type ProviderModel, type ProviderServices } from '@floway-dev/provider';
import { assertExists } from '@floway-dev/test-utils';

export const azureInput = <Payload>(model: ProviderModel, payload: Payload, headers: readonly HeaderEntry[] = []): ProviderInput<Payload> => ({
  'provider.model': toProviderModelFacts(model),
  'request.headers': headers,
  'request.payload': payload,
});

export const callAzure = async <In, Out extends ProviderHttpOutput & { 'response.events'?: ManagedStream<unknown> | undefined }>(
  pipeline: Pipeline<In, Out, ProviderServices> | undefined,
  facts: NoInfer<In>,
  fetcher: Fetcher = directFetcher,
  events?: RunEventSink,
) => {
  assertExists(pipeline);
  const handle = run(pipeline, facts, { services: { fetcher: () => fetcher }, finalizationTimeoutMs: 100, events });
  const result = await handle.result;
  const body = await readHttpBody(result['response.http'].body);
  await result['response.events']?.close();
  expect(await handle.done).toEqual({ ok: true });
  return { ...result, body };
};
