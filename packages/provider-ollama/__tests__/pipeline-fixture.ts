import { expect } from 'vitest';

import { createOllamaService, toOllamaUpstreamFacts, type OllamaServices, type OllamaUpstreamFacts } from '../src/index.ts';
import { run, type Pipeline, type RunEvent, type RunEventSink } from '@floway-dev/pipeline';
import {
  directFetcher, httpUrl, readHttpBody, toProviderModelFacts, wrapSensitiveHeaderEntries,
  type Fetcher, type HeaderEntry, type ProviderAnthropicMessagesOutput, type ProviderBaseOutput, type ProviderInput,
  type ProviderModel, type ProviderOpenAIChatCompletionsOutput, type ProviderOpenAIResponsesOutput, type UpstreamRecord,
} from '@floway-dev/provider';

export const ollamaInput = <Payload>(
  record: UpstreamRecord, model: ProviderModel, payload: Payload, headers: readonly HeaderEntry[] = [],
): ProviderInput<OllamaUpstreamFacts, Payload> => ({
  'provider.upstream': toOllamaUpstreamFacts(record),
  'provider.model': toProviderModelFacts(model),
  'request.http': { method: 'POST', url: httpUrl('http://floway.test/v1/request'), headers: wrapSensitiveHeaderEntries(headers), body: null },
  'request.payload': payload,
});

export const ollamaServices = (fetcher: Fetcher = directFetcher): OllamaServices => ({
  fetcher: () => fetcher,
  ollama: createOllamaService(),
});

type TestOutput = ProviderBaseOutput & Partial<ProviderAnthropicMessagesOutput & ProviderOpenAIChatCompletionsOutput & ProviderOpenAIResponsesOutput>;

export const callOllama = async <In, Out extends TestOutput>(
  pipeline: Pipeline<In, Out, OllamaServices>,
  facts: NoInfer<In>,
  services = ollamaServices(),
  events?: RunEventSink,
) => {
  const handle = run(pipeline, facts, { services, finalizationTimeoutMs: 1_000, events });
  const result = await handle.result;
  const body = await readHttpBody(result['response.http'].body);
  for (const outcome of [result['response.anthropicMessages'], result['response.openaiChatCompletions'], result['response.openaiResponses']]) {
    if (outcome?.kind === 'stream') await outcome.events.close();
  }
  expect(await handle.done).toEqual({ ok: true });
  return { ...result, body };
};

export const settledProbes = (events: readonly RunEvent[]) => events.flatMap(event => {
  if (event.k !== 'deferred' || !event.name.startsWith('ollama.')) return [];
  const result = events.find(candidate => candidate.k === 'settled' && candidate.deferredId === event.deferredId);
  return [{ name: event.name, result }];
});
