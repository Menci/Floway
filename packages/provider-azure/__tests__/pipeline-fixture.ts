import { expect } from 'vitest';

import type { AzureUpstreamFacts } from '../src/index.ts';
import { Bytes, run, type Pipeline, type RunEventSink } from '@floway-dev/pipeline';
import {
  directFetcher,
  httpUrl,
  readHttpBody,
  toProviderModelFacts,
  wrapSensitiveHeaderEntries,
  type Fetcher,
  type HeaderEntry,
  type ProviderAnthropicMessagesOutput,
  type ProviderBaseOutput,
  type ProviderInput,
  type ProviderModel,
  type ProviderOpenAIChatCompletionsOutput,
  type ProviderOpenAIResponsesOutput,
  type ProviderServices,
} from '@floway-dev/provider';

export const azureInput = <Payload>(
  upstream: AzureUpstreamFacts, model: ProviderModel, payload: Payload, headers: readonly HeaderEntry[] = [],
): ProviderInput<AzureUpstreamFacts, Payload> => ({
  'provider.upstream': upstream,
  'provider.model': toProviderModelFacts(model),
  'request.http': {
    method: 'POST',
    url: httpUrl('https://floway.example/v1/request?client=true'),
    headers: wrapSensitiveHeaderEntries(headers),
    body: Bytes.fromUtf8('{}'),
  },
  'request.payload': payload,
});

type AzureOutput = ProviderBaseOutput & Partial<Pick<
  ProviderOpenAIChatCompletionsOutput & ProviderOpenAIResponsesOutput & ProviderAnthropicMessagesOutput,
  'response.openaiChatCompletions' | 'response.openaiResponses' | 'response.anthropicMessages'
>>;

export const callAzure = async <In extends { readonly 'provider.upstream': AzureUpstreamFacts }, Out extends AzureOutput>(
  pipeline: Pipeline<In, Out, ProviderServices>,
  facts: NoInfer<In>,
  fetcher: Fetcher = directFetcher,
  events?: RunEventSink,
) => {
  const handle = run(pipeline, facts, {
    services: {
      fetcher: upstreamId => {
        expect(upstreamId).toBe(facts['provider.upstream'].id);
        return fetcher;
      },
    },
    finalizationTimeoutMs: 100,
    events,
  });
  const result = await handle.result;
  const body = await readHttpBody(result['response.http'].body);
  for (const outcome of [result['response.openaiChatCompletions'], result['response.openaiResponses'], result['response.anthropicMessages']]) {
    if (outcome?.kind === 'stream') await outcome.events.close();
  }
  expect((await handle.done).ok).toBe(true);
  if (!body.ok) throw new Error(body.error.message);
  return { ...result, body: body.bytes };
};
