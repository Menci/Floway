import type { ChatGPTUpstream } from '../../src/config.ts';
import { chatgptPipelines } from '../../src/pipelines/index.ts';
import type { ChatGPTService, ChatGPTServices } from '../../src/service.ts';
import type { HttpResponseFact, ProviderFetcher } from '@floway-dev/http';
import { run, type Pipeline, type RunEvent } from '@floway-dev/pipeline';
import { type JsonObject } from '@floway-dev/protocols/common';
import type { OpenAIImagesGenerationsPayload } from '@floway-dev/protocols/openai-images';
import type { CanonicalOpenAIResponsesCompactPayload, CanonicalOpenAIResponsesPayload } from '@floway-dev/protocols/openai-responses';
import { directFetcher, toProviderModelFact, type OpenAIImagesEditsPayload, type ProviderModel, type ProviderOperation, type ProviderRequestFacts } from '@floway-dev/provider';

export const runChatGPTPipeline = <I, O>(pipeline: Pipeline<I, O, ChatGPTServices>, facts: NoInfer<I>, service: ChatGPTService, opts: {
  fetcher?: ProviderFetcher;
  events?: (event: RunEvent) => void;
  waitUntil?: (promise: Promise<unknown>) => void;
} = {}) => {
  const controller = new AbortController();
  const detached: Promise<unknown>[] = [];
  return {
    controller,
    detached,
    running: run(pipeline, facts, {
      signal: controller.signal,
      services: { fetcher: () => opts.fetcher ?? (async (url, init) => ({ response: await directFetcher(url, init) })), chatgpt: service },
      waitUntil(work) {
        detached.push(work);
        opts.waitUntil?.(work);
      },
      ...(opts.events === undefined ? {} : { events: opts.events }),
    }),
  };
};

const headersFrom = (headers: HttpResponseFact['headers']): Headers => {
  const values = new Headers();
  for (const [key, value] of headers) {
    if (typeof value !== 'string') throw new TypeError('Expected clear response headers in test');
    values.append(key, value);
  }
  return values;
};

const requireHttp = (http: HttpResponseFact | null) => {
  if (http === null) throw new Error('Expected HTTP response');
  return { ...http, headers: headersFrom(http.headers) };
};

export interface PipelineRequest<Body> {
  body: Body;
  headers: Headers;
  model: ProviderModel;
  waitUntil?: (promise: Promise<unknown>) => void;
}

export const chatgptPipelineRequests = (upstream: () => ChatGPTUpstream, service: () => ChatGPTService) => {
  const execute = <Op extends ProviderOperation, O>(operation: Op, pipeline: Pipeline<ProviderRequestFacts<Op, ChatGPTUpstream>, O, ChatGPTServices>, request: PipelineRequest<ProviderRequestFacts<Op>[`request.${Op}`]>) => {
    const facts = {
      'request.http': { url: 'https://floway.test', method: 'POST', headers: [...request.headers], body: null },
      'provider.upstream': upstream(),
      'provider.model': toProviderModelFact(request.model),
      [`request.${operation}`]: request.body,
    } as ProviderRequestFacts<Op, ChatGPTUpstream>;
    return runChatGPTPipeline(pipeline, facts, service(), request.waitUntil === undefined ? {} : { waitUntil: request.waitUntil });
  };

  return {
    async openaiResponses(request: PipelineRequest<Omit<CanonicalOpenAIResponsesPayload, 'model'>>) {
      const { controller, running, detached } = execute('openaiResponses', chatgptPipelines.openaiResponses, { ...request, body: { ...request.body, model: request.model.id } });
      const answer = await running.result;
      const outcome = answer['response.openaiResponses'];
      const http = requireHttp(answer['response.http']);
      if (outcome.kind === 'error') {
        await running.done;
        controller.abort();
        return { outcome, http, detached };
      }
      const events = await Array.fromAsync(running.read(outcome.stream));
      await running.done;
      controller.abort();
      return { outcome, http, events, detached };
    },
    async openaiResponsesCompact(request: PipelineRequest<Omit<CanonicalOpenAIResponsesCompactPayload, 'model'>>) {
      const { controller, running, detached } = execute('openaiResponsesCompact', chatgptPipelines.openaiResponsesCompact, { ...request, body: { ...request.body, model: request.model.id } });
      const answer = await running.result;
      await running.done;
      controller.abort();
      return { http: requireHttp(answer['response.http']), outcome: answer['response.openaiResponsesCompact'], detached };
    },
    async openaiImagesGenerations(request: PipelineRequest<OpenAIImagesGenerationsPayload>) {
      const { controller, running, detached } = execute('openaiImagesGenerations', chatgptPipelines.openaiImagesGenerations, request);
      const answer = await running.result;
      const outcome = answer['response.openaiImagesGenerations'];
      const events = outcome.kind === 'stream' ? await Array.fromAsync(running.read(outcome.stream)) : [];
      await running.done;
      controller.abort();
      return { http: requireHttp(answer['response.http']), outcome, events, detached };
    },
    async openaiImagesEdits(request: PipelineRequest<OpenAIImagesEditsPayload>) {
      const { controller, running, detached } = execute('openaiImagesEdits', chatgptPipelines.openaiImagesEdits, request);
      const answer = await running.result;
      const outcome = answer['response.openaiImagesEdits'];
      const events = outcome.kind === 'stream' ? await Array.fromAsync(running.read(outcome.stream)) : [];
      await running.done;
      controller.abort();
      return { http: requireHttp(answer['response.http']), outcome, events, detached };
    },
    async alphaSearch(request: PipelineRequest<JsonObject>) {
      const { controller, running, detached } = execute('alphaSearch', chatgptPipelines.alphaSearch, request);
      const answer = await running.result;
      await running.done;
      controller.abort();
      return { http: requireHttp(answer['response.http']), outcome: answer['response.alphaSearch'], detached };
    },
  };
};
