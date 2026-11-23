import { toCopilotUpstreamFacts, type CopilotUpstreamFacts } from '../src/config.ts';
import { clearInProcessCopilotTokenCache, defaultCopilotService, type CopilotServices } from '../src/service.ts';
import { compose, run, type ManagedStream, type Pipeline, type RunEvent, type Stage } from '@floway-dev/pipeline';
import { createInMemoryImageProcessor, initImageProcessor } from '@floway-dev/platform';
import type { AnthropicMessagesPayload } from '@floway-dev/protocols/anthropic-messages';
import type { ProtocolFrame } from '@floway-dev/protocols/common';
import type { CanonicalOpenAIResponsesPayload } from '@floway-dev/protocols/openai-responses';
import { directFetcher, httpTerminal, httpUrl, initProviderRepo, isReplayableBody, readHttpBody, rewriteHttpRequestStage, toProviderModelFacts, type Fetcher, type OpenAIResponsesAction, type ProtocolOutcome, type ProviderAnthropicInput, type ProviderAnthropicMessagesOutput, type ProviderBaseOutput, type ProviderInput, type ProviderModel, type ProviderOpenAIChatCompletionsOutput, type ProviderOpenAIResponsesOutput, type ProviderResponsesInput, type UpstreamRecord } from '@floway-dev/provider';
import { assertEquals, jsonResponse, stubProviderModel } from '@floway-dev/test-utils';

export const runCopilotPipeline = <Input, Output>(
  pipeline: Pipeline<Input, Output, CopilotServices>,
  facts: NoInfer<Input>,
  fetcher: Fetcher = directFetcher,
  options: { signal?: AbortSignal; events?: (event: RunEvent) => void } = {},
) => {
  return run(pipeline, facts, {
    services: { copilot: defaultCopilotService, fetcher: () => fetcher },
    finalizationTimeoutMs: 1_000,
    ...options,
  });
};

const selectStream = <Event, Result>(outcome: ProtocolOutcome<Event, Result> | undefined) =>
  outcome?.kind === 'stream' ? outcome.events : undefined;

const settleCopilotPipeline = async <Input, Output extends ProviderBaseOutput, Event>(
  pipeline: Pipeline<Input, Output, CopilotServices>,
  facts: NoInfer<Input>,
  fetcher: Fetcher | undefined,
  selectEvents: (output: Output) => ManagedStream<Event> | undefined,
) => {
  const trace: RunEvent[] = [];
  const handle = runCopilotPipeline(pipeline, facts, fetcher, { events: event => trace.push(event) });
  const { output, body, events } = await (async () => {
    try {
      const output = await handle.result;
      const body = await readHttpBody(output['response.http'].body);
      const stream = selectEvents(output);
      const events = stream === undefined ? undefined : await Array.fromAsync(stream);
      return { output, body, events };
    } finally {
      await handle.done;
    }
  })();
  assertEquals(await handle.done, { ok: true });
  return { output, body, events, trace };
};

export const modelInput = <Payload>(
  model: ProviderModel, payload: Payload, upstream = toCopilotUpstreamFacts(buildCopilotUpstream()),
): ProviderInput<CopilotUpstreamFacts, Payload> => ({
  'provider.upstream': upstream,
  'provider.model': toProviderModelFacts(model),
  'request.http': { method: 'POST', url: httpUrl('https://floway.test'), headers: [], body: null },
  'request.payload': payload,
});

type ChatTestOutput = ProviderBaseOutput & Partial<Pick<ProviderOpenAIChatCompletionsOutput, 'response.openaiChatCompletions'>>;

export const invokeModel = <Payload, Output extends ChatTestOutput>(
  pipeline: Pipeline<ProviderInput<CopilotUpstreamFacts, Payload>, Output, CopilotServices>,
  model: ProviderModel,
  payload: NoInfer<Payload>,
  fetcher?: Fetcher,
) => settleCopilotPipeline(pipeline, modelInput(model, payload), fetcher, output => selectStream(output['response.openaiChatCompletions']));

type AnthropicTestOutput = ProviderBaseOutput & Partial<Pick<ProviderAnthropicMessagesOutput, 'response.anthropicMessages'>>;

export const invokeAnthropic = <Output extends AnthropicTestOutput>(
  pipeline: Pipeline<ProviderAnthropicInput<CopilotUpstreamFacts>, Output, CopilotServices>,
  model: ProviderModel,
  payload: Omit<AnthropicMessagesPayload, 'model'>,
  beta: readonly string[] = [],
  fetcher?: Fetcher,
) => settleCopilotPipeline(pipeline, {
  ...modelInput(model, payload),
  'request.anthropicBeta': beta,
}, fetcher, output => selectStream(output['response.anthropicMessages']));

export const invokeResponses = (
  pipeline: Pipeline<ProviderResponsesInput<CopilotUpstreamFacts>, ProviderOpenAIResponsesOutput, CopilotServices>,
  model: ProviderModel,
  payload: Omit<CanonicalOpenAIResponsesPayload, 'model'>,
  action: OpenAIResponsesAction,
  fetcher?: Fetcher,
) => settleCopilotPipeline(pipeline, {
  ...modelInput(model, payload),
  'request.action': action,
}, fetcher, output => selectStream(output['response.openaiResponses']));

const buildCopilotUpstream = (overrides: Partial<UpstreamRecord> = {}): UpstreamRecord => {
  const { config: overrideConfig, ...rest } = overrides;
  return {
    id: 'up_copilot',
    kind: 'copilot',
    name: 'GitHub Copilot (tester)',
    enabled: true,
    usageRefreshIntervalMinutes: 0,
    sortOrder: 0,
    createdAt: '2026-03-15T00:00:00.000Z',
    updatedAt: '2026-03-15T00:00:00.000Z',
    state: null,
    flagOverrides: {},
    disabledPublicModelIds: [],
    proxyFallbackList: [],
    modelPrefix: null,
    modelsCache: null,
    hue: 210,
    ...rest,
    config: overrideConfig ?? {
      githubHost: 'github.com',
      githubToken: `ghu_${crypto.randomUUID().replace(/-/g, '')}`,
      user: { id: 1, login: 'tester', name: 'Test User', avatar_url: 'https://example.com/avatar.png' },
    },
  };
};

interface CopilotTestRepo {
  copilotUpstream: UpstreamRecord;
  setUpstreamState: (state: unknown) => void;
  getCurrentState: () => unknown;
  overrideSaveState: (impl: (id: string, mutate: (current: unknown) => unknown) => Promise<void>) => void;
}

export const setupCopilotTest = async (recordOverrides: Partial<UpstreamRecord> = {}): Promise<CopilotTestRepo> => {
  let upstream = buildCopilotUpstream(recordOverrides);
  // Applies the mutator to the row as it stands, the way the repo does.
  let saveStateImpl: (id: string, mutate: (current: unknown) => unknown) => Promise<void> = async (_id, mutate) => {
    const next = mutate(upstream.state);
    upstream = { ...upstream, state: next };
  };
  initProviderRepo(() => ({
    recordUpstreamMetric: async () => {},
    upstreams: {
      getById: async () => ({ ...upstream, configVersion: 1 }),
      saveState: (id, mutate) => saveStateImpl(id, current => mutate(current, 1)),
    },
  }));
  initImageProcessor(createInMemoryImageProcessor());
  clearInProcessCopilotTokenCache();
  return {
    copilotUpstream: upstream,
    setUpstreamState: state => { upstream = { ...upstream, state }; },
    getCurrentState: () => upstream.state,
    overrideSaveState: impl => { saveStateImpl = impl; },
  };
};

export const fakeCopilotWire = async (endpoint: string, rawModel: string, respond: (request: Request) => Response | Promise<Response>) => {
  const repo = await setupCopilotTest();
  const model = stubProviderModel({
    id: rawModel,
    providerData: { rawModels: [{ id: rawModel, supported_endpoints: [endpoint] }] },
  });
  const fetcher: Fetcher = async (url, init) => {
    if (new URL(url).pathname === '/copilot_internal/v2/token') {
      return jsonResponse({
        token: 'tok-stages',
        expires_at: 4_102_444_800,
        refresh_in: 1_800,
        endpoints: { api: 'https://api.individual.githubcopilot.com' },
      });
    }
    if (isReplayableBody(init.body)) throw new Error('Expected the Copilot HTTP terminal to materialize the body');
    return await respond(new Request(url, { ...init, body: init.body }));
  };
  return { model, fetcher, repo };
};

export const inspectRequestStage = async <Payload extends { model: string }>(
  stages: readonly Stage<CopilotServices>[],
  name: string,
  payload: Payload,
  options: { beta?: readonly string[]; model?: string } = {},
) => {
  const stage = stages.find(candidate => candidate.name === name);
  if (stage === undefined) throw new Error(`Copilot did not register ${name}`);
  type Input = ProviderInput<CopilotUpstreamFacts, Omit<Payload, 'model'>> & { 'request.anthropicBeta': readonly string[] };
  let transformed: Omit<Payload, 'model'> | undefined;
  const capture = rewriteHttpRequestStage<Input>('capture', ['request.payload'], facts => {
    transformed = facts['request.payload'];
    return {
      request: {
        method: 'POST',
        url: httpUrl('https://copilot.test'),
        body: { kind: 'json', value: transformed },
      },
      modelKey: payload.model,
    };
  });
  const pipeline = compose<Input & ProviderBaseOutput, CopilotServices>()(stage.name, {
    entry: ['provider.upstream', 'provider.model', 'request.payload', 'request.http', 'request.anthropicBeta'],
    exit: ['response.http', 'response.modelKey'],
    stages: [stage, capture],
    ending: httpTerminal,
  });
  const { model: _model, ...body } = payload;
  const model = stubProviderModel({ id: options.model ?? payload.model });
  let headers: Headers | undefined;
  await settleCopilotPipeline(pipeline, {
    ...modelInput(model, body),
    'request.anthropicBeta': options.beta ?? [],
  }, async (_url, init) => {
    headers = new Headers(init.headers);
    return jsonResponse({});
  }, () => undefined);
  if (headers === undefined || transformed === undefined) throw new Error('Expected the Copilot stage to dispatch');
  return { headers, payload: { ...transformed, model: payload.model } };
};

export const protocolSse = <Event>(frames: AsyncIterable<ProtocolFrame<Event>> | readonly ProtocolFrame<Event>[]): Response => {
  const iterate = async function* () { yield* frames; };
  const iterator = iterate();
  const encoder = new TextEncoder();
  return new Response(new ReadableStream<Uint8Array>({
    async pull(controller) {
      const { done, value } = await iterator.next();
      if (done) controller.close();
      else controller.enqueue(encoder.encode(`data: ${value.type === 'done' ? '[DONE]' : JSON.stringify(value.event)}\n\n`));
    },
    async cancel() {
      await iterator.return(undefined);
    },
  }, { highWaterMark: 0 }), { headers: { 'content-type': 'text/event-stream' } });
};
