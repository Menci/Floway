import type { KimiCodeUpstreamConfig } from './config.ts';
import { kimiCodeUrl } from './fetch.ts';
import { selectKimiCodeModel, type KimiCodeModelSelection } from './model-selection.ts';
import { isKimiCodeAccountProbeDue, isKimiCodeUsageProbeDue, refreshKimiCodeAccountProbe, refreshKimiCodeUsageProbe } from './probe.ts';
import { withKimiCodeChatTier, withKimiCodeMessagesSpeed, withKimiCodeResponsesTier, kimiCodeMessagesWireBody } from './speed.ts';
import { readKimiCodeUpstreamState } from './state.ts';
import { Bytes, compose, defineStage, secret, snapshotError, transform, type Deferred, type ErrorSnapshot, type ManagedStream, type Stage, type StageEnv } from '@floway-dev/pipeline';
import { parseAnthropicMessagesStream, type AnthropicMessagesStreamEventEx } from '@floway-dev/protocols/anthropic-messages';
import { eventFrame, FAST_SERVICE_TIER, isFastServiceTier, type ProtocolFrame } from '@floway-dev/protocols/common';
import { parseOpenAIChatCompletionsStream, type OpenAIChatCompletionsPayloadEx, type OpenAIChatCompletionsStreamEvent } from '@floway-dev/protocols/openai-chat-completions';
import { parseOpenAIResponsesStream, type OpenAIResponsesStreamEventEx } from '@floway-dev/protocols/openai-responses';
import {
  buildHttpRequestStage,
  headersForAnthropicMessagesCall,
  httpTerminal,
  httpUrl,
  parseSseStage,
  type HeaderEntry,
  type ProviderAnthropicInput,
  type ProviderHttpOutput,
  type ProviderHttpRequest,
  type ProviderInput,
  type ProviderModelFacts,
  type ProviderPipelines,
  type ProviderResponsesInput,
  type ProviderResponsesOutput,
  type ProviderServices,
  type ProviderStreamOutput,
  type UpstreamRecord,
} from '@floway-dev/provider';

type ChatInput = ProviderInput<Omit<OpenAIChatCompletionsPayloadEx, 'model'>>;
type Selected<Input> = Input & { readonly 'request.kimi.selection': KimiCodeModelSelection };
type RequestShape = ProviderInput<object>;
type OpenAiRequest = ProviderInput<{ readonly service_tier?: string | null }>;
type ApiRejection = { readonly anthropic: boolean; readonly message: string };
type Route = KimiCodeModelSelection | ApiRejection;

const selectedRequestKeys: readonly (keyof Selected<RequestShape>)[] = ['request.kimi.selection', 'request.headers', 'request.payload'];
const selectedAnthropicKeys: readonly (keyof Selected<ProviderAnthropicInput>)[] = [...selectedRequestKeys, 'request.anthropicBeta'];
const responseKeys = ['response.http', 'response.modelKey'];

const fastModeRequired = (model: ProviderModelFacts, field: 'service_tier' | 'speed'): ApiRejection => ({
  anthropic: field === 'speed',
  message: `'${model.id}' is only available with fast mode selected; set \`${field}: "${field === 'speed' ? 'fast' : FAST_SERVICE_TIER}"\`.`,
});

const selectOpenAi = (facts: OpenAiRequest): Route => {
  const model = facts['provider.model'];
  return selectKimiCodeModel(model, isFastServiceTier(facts['request.payload'].service_tier)) ?? fastModeRequired(model, 'service_tier');
};

const selectMessages = (facts: ProviderAnthropicInput): Route => {
  const model = facts['provider.model'];
  const fast = facts['request.payload'].speed === 'fast';
  const selection = selectKimiCodeModel(model, fast);
  // Anthropic rejects fast requests on unsupported models. OpenAI permits a standard-speed response carrying the selected tier.
  // https://platform.claude.com/docs/en/build-with-claude/fast-mode
  // https://developers.openai.com/api/docs/guides/priority-processing
  if (fast && selection?.lane !== 'fast') {
    return { anthropic: true, message: `'${model.id}' does not support fast mode; omit \`speed\` or set \`speed: "standard"\`.` };
  }
  return selection ?? fastModeRequired(model, 'speed');
};

const selectRequest = <Input extends RequestShape, Output extends ProviderHttpOutput>(
  select: (facts: Input) => Route,
  answer: (facts: ProviderHttpOutput) => Output,
  extraOutput: readonly (keyof Output & string)[],
) => defineStage<Input, Selected<Input>, Output, Output, ProviderServices>({
  name: 'selectModelLane',
  through: {
    request: { needs: ['provider.model', 'request.payload'], consumes: [], provides: ['request.kimi.selection'] },
    response: { needs: [], consumes: [], provides: [] },
  },
  return: { provides: [...responseKeys, ...extraOutput] },
  async execute(facts, next, env) {
    const route = select(facts);
    if ('modelId' in route) return await next({ ...facts, 'request.kimi.selection': route });
    const body = {
      ...(route.anthropic ? { type: 'error' } : {}),
      error: { type: 'invalid_request_error', message: route.message },
    };
    const now = env.clock();
    return answer({
      'response.http': {
        status: 400,
        statusText: '',
        headers: [['content-type', 'application/json']],
        body: Bytes.fromUtf8(JSON.stringify(body)),
        timing: { startedAt: now, headersAt: now },
      },
      'response.modelKey': facts['provider.model'].upstreamModelId,
    });
  },
});

type EventsOutput<Event> = { readonly 'response.events': ManagedStream<ProtocolFrame<Event>> | undefined };

const annotateFrames = <Input, Event>(
  mapping: (facts: Selected<Input>) => ((event: Event) => Event) | undefined,
) => defineStage<Selected<Input>, Selected<Input>, EventsOutput<Event>, EventsOutput<Event>, ProviderServices>({
  name: 'annotateSpeed',
  through: {
    request: { needs: ['request.payload', 'request.kimi.selection'], consumes: [], provides: [] },
    response: { needs: ['response.events'], consumes: [], provides: ['response.events'] },
  },
  async execute(facts, next, env) {
    const back = await next(facts);
    const events = back['response.events'];
    const map = mapping(facts);
    if (!events || !map) return back;
    const annotated = env.wrapStream(events, {
      label: 'kimi.speed',
      async *transform(source) {
        for await (const frame of source) yield frame.type === 'done' ? frame : eventFrame(map(frame.event));
      },
    });
    return { ...back, 'response.events': annotated };
  },
});

const selectedTier = (selection: KimiCodeModelSelection) => selection.lane === 'fast' ? FAST_SERVICE_TIER : 'default';

const annotateOpenAi = <Input extends OpenAiRequest, Event>(
  annotate: (event: Event, tier: 'priority' | 'default') => Event,
) => annotateFrames<Input, Event>(facts => {
  if (!isFastServiceTier(facts['request.payload'].service_tier)) return undefined;
  const tier = selectedTier(facts['request.kimi.selection']);
  return event => annotate(event, tier);
});

type ProbeResult = { readonly persisted: true } | { readonly persisted: false; readonly error: ErrorSnapshot };
type ProbeOutput = ProviderHttpOutput & {
  readonly 'response.provider.usageProbe': Deferred<ProbeResult> | undefined;
  readonly 'response.provider.accountProbe': Deferred<ProbeResult> | undefined;
};

const deferProbe = (
  name: 'usage' | 'account', upstreamId: string, work: Promise<unknown>, env: StageEnv<ProviderServices>,
): Deferred<ProbeResult> => env.defer(`kimiCode.${name}Probe`, work.then<ProbeResult, ProbeResult>(
  () => ({ persisted: true }),
  (error: unknown) => {
    const warning = `Failed to refresh Kimi Code ${name} for ${upstreamId}:`;
    console.warn(warning, error);
    const snapshot = snapshotError(error);
    env.log.warn(warning, { error: snapshot });
    return { persisted: false, error: snapshot };
  },
));

const probeAfterResponse = (record: UpstreamRecord, config: KimiCodeUpstreamConfig) => {
  const { id } = record;
  return defineStage<{}, {}, ProviderHttpOutput, ProbeOutput, ProviderServices>({
    name: 'probeAfterResponse',
    through: {
      request: { needs: [], consumes: [], provides: [] },
      response: { needs: ['response.http'], consumes: [], provides: ['response.provider.usageProbe', 'response.provider.accountProbe'] },
    },
    async execute(facts, next, env) {
      const back = await next(facts);
      const { status } = back['response.http'];
      const state = readKimiCodeUpstreamState(record.state);
      const now = Date.now();
      // Quota exhaustion and plan restrictions warrant a current usage reading.
      // https://www.kimi.com/code/docs/en/kimi-code/error-reference.html
      const usage = status === 429 || status === 403 || isKimiCodeUsageProbeDue(state, now)
        ? deferProbe('usage', id, refreshKimiCodeUsageProbe(id, config, env.services.fetcher(id)), env)
        : undefined;
      const account = isKimiCodeAccountProbeDue(state, now)
        ? deferProbe('account', id, refreshKimiCodeAccountProbe(id, config, env.services.fetcher(id)), env)
        : undefined;
      return { ...back, 'response.provider.usageProbe': usage, 'response.provider.accountProbe': account };
    },
  });
};

const rejectStream = (back: ProviderHttpOutput) => ({ ...back, 'response.events': undefined });

const responsesGeneration = defineStage<
  ProviderResponsesInput, ProviderResponsesInput, ProviderStreamOutput<OpenAIResponsesStreamEventEx>, ProviderResponsesOutput
>({
  name: 'responsesGeneration',
  through: {
    request: { needs: ['request.action'], consumes: [], provides: [] },
    response: { needs: ['response.events'], consumes: [], provides: ['response.result'] },
  },
  execute: transform(() => ({
    request: facts => {
      if (facts['request.action'] === 'compact') throw new Error('Kimi Code does not expose a native Responses compaction endpoint');
      return facts;
    },
    response: back => ({ ...back, 'response.result': undefined }),
  })),
});

export const createKimiCodePipelines = (record: UpstreamRecord, config: KimiCodeUpstreamConfig): ProviderPipelines => {
  const ending = httpTerminal(record.id);
  const assemble = <In, Out>(operation: string, ...stages: Stage<ProviderServices>[]) =>
    compose<In, Out, ProviderServices>(`${record.id}.${operation}`, { stages, ending });
  const authorization = secret(`Bearer ${config.apiKey}`);
  const request = (path: string, value: object, extra: readonly HeaderEntry[]): ProviderHttpRequest => {
    const headers = new Map<string, HeaderEntry[1]>();
    for (const [name, value] of extra) headers.set(name.toLowerCase(), value);
    headers.set('authorization', authorization);
    headers.set('content-type', 'application/json');
    return { method: 'POST', url: httpUrl(kimiCodeUrl(config.region, path)), headers: [...headers], body: { kind: 'json', value } };
  };
  const probe = probeAfterResponse(record, config);
  const openAi = <Input extends OpenAiRequest>(path: string) =>
    buildHttpRequestStage<Selected<Input>>('buildRequest', selectedRequestKeys, facts => {
      const selection = facts['request.kimi.selection'];
      const payload = facts['request.payload'];
      const value = {
        ...payload,
        ...(isFastServiceTier(payload.service_tier) ? { service_tier: selectedTier(selection) } : {}),
        stream: true,
        model: selection.modelId,
      };
      return { modelKey: selection.modelId, request: request(path, value, facts['request.headers']) };
    });
  const messages = (stream: boolean) => buildHttpRequestStage<Selected<ProviderAnthropicInput>>('buildRequest', selectedAnthropicKeys, facts => {
    const modelKey = facts['request.kimi.selection'].modelId;
    const payload = kimiCodeMessagesWireBody(facts['request.payload']);
    const value = { ...payload, ...(stream ? { stream: true } : {}), model: modelKey };
    const headers = headersForAnthropicMessagesCall(facts['request.headers'], facts['request.anthropicBeta']);
    return { modelKey, request: request(stream ? '/messages' : '/messages/count_tokens', value, headers) };
  });

  // Thinking and effort are forwarded unchanged. Responses echo the requested
  // model, including when Kimi routes a disabled-thinking request to another model.
  // https://www.kimi.com/code/docs/en/kimi-code/models.html
  return {
    openaiChatCompletions: assemble(
      'openaiChatCompletions',
      selectRequest<ChatInput, ProviderStreamOutput<OpenAIChatCompletionsStreamEvent>>(selectOpenAi, rejectStream, ['response.events']),
      annotateOpenAi<ChatInput, OpenAIChatCompletionsStreamEvent>(withKimiCodeChatTier),
      parseSseStage('parseSse', parseOpenAIChatCompletionsStream),
      probe,
      openAi<ChatInput>('/chat/completions'),
    ),
    openaiResponses: assemble(
      'openaiResponses',
      responsesGeneration,
      selectRequest<ProviderResponsesInput, ProviderStreamOutput<OpenAIResponsesStreamEventEx>>(selectOpenAi, rejectStream, ['response.events']),
      annotateOpenAi<ProviderResponsesInput, OpenAIResponsesStreamEventEx>(withKimiCodeResponsesTier),
      parseSseStage('parseSse', parseOpenAIResponsesStream),
      probe,
      openAi<ProviderResponsesInput>('/responses'),
    ),
    anthropicMessages: assemble(
      'anthropicMessages',
      selectRequest<ProviderAnthropicInput, ProviderStreamOutput<AnthropicMessagesStreamEventEx>>(selectMessages, rejectStream, ['response.events']),
      annotateFrames<ProviderAnthropicInput, AnthropicMessagesStreamEventEx>(facts => {
        const { speed } = facts['request.payload'];
        if (speed !== 'fast' && speed !== 'standard') return undefined;
        return event => withKimiCodeMessagesSpeed(event, speed === 'fast' ? 'fast' : 'standard');
      }),
      parseSseStage('parseSse', parseAnthropicMessagesStream),
      probe,
      messages(true),
    ),
    anthropicMessagesCountTokens: assemble(
      'anthropicMessagesCountTokens',
      selectRequest(selectMessages, back => back, []),
      messages(false),
    ),
  };
};
