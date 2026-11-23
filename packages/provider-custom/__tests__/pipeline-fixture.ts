import { expect } from 'vitest';

import { toCustomUpstreamFacts, type CustomUpstreamFacts } from '../src/upstream.ts';
import { isManagedStream, run, type Pipeline, type RunEventSink } from '@floway-dev/pipeline';
import { directFetcher, httpUrl, readHttpBody, toProviderModelFacts, type Fetcher, type HeaderEntry, type ProviderBaseOutput, type ProviderInput, type ProviderModel, type ProviderServices, type UpstreamRecord } from '@floway-dev/provider';

export const customInput = <Payload>(record: UpstreamRecord, model: ProviderModel, payload: Payload, headers: readonly HeaderEntry[] = []): ProviderInput<CustomUpstreamFacts, Payload> => ({
  'provider.upstream': toCustomUpstreamFacts(record),
  'provider.model': toProviderModelFacts(model),
  'request.http': { method: 'POST', url: httpUrl('https://floway.example/inbound'), headers, body: null },
  'request.payload': payload,
});

export const callCustom = async <In, Out extends ProviderBaseOutput>(
  pipeline: Pipeline<In, Out, ProviderServices>,
  facts: NoInfer<In>,
  fetcher: Fetcher = directFetcher,
  events?: RunEventSink,
) => {
  const handle = run(pipeline, facts, { services: { fetcher: () => fetcher }, finalizationTimeoutMs: 100, events });
  const result = await handle.result;
  const body = await readHttpBody(result['response.http'].body);
  const outputs: readonly unknown[] = Object.values(result);
  for (const value of outputs) {
    if (typeof value === 'object' && value !== null && 'events' in value && isManagedStream(value.events)) {
      await value.events.close();
    }
  }
  expect(await handle.done).toEqual({ ok: true });
  if (!body.ok) throw new Error(body.error.message);
  return { ...result, body: body.bytes };
};
