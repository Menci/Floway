import type { KimiCodeUpstreamFacts } from './config.ts';
import { kimiCodeUrl } from './fetch.ts';
import { selectKimiCodeModel, type KimiCodeModelSelection } from './model-selection.ts';
import type { KimiCodeServices } from './service.ts';
import { kimiCodeMessagesWireBody, withKimiCodeChatTier, withKimiCodeMessagesSpeed, withKimiCodeResponsesTier } from './speed.ts';
import { Bytes, compose, defineStage, secret, snapshotError, transform } from '@floway-dev/pipeline';
import { parseAnthropicMessagesStream, type AnthropicMessagesStreamEventEx } from '@floway-dev/protocols/anthropic-messages';
import { eventFrame, FAST_SERVICE_TIER, isFastServiceTier } from '@floway-dev/protocols/common';
import { parseOpenAIChatCompletionsStream, type OpenAIChatCompletionsPayloadEx, type OpenAIChatCompletionsStreamEvent } from '@floway-dev/protocols/openai-chat-completions';
import type { OpenAIResponsesCompactionResultEx, OpenAIResponsesStreamEventEx } from '@floway-dev/protocols/openai-responses';
import {
  headersForAnthropicMessagesCall,
  httpTerminal,
  httpUrl,
  parseHttpOutcomeStage,
  parseResponsesStage,
  parseSseStage,
  rewriteHttpRequestStage,
  setHeader,
  stripHttpHeaders,
  type HttpOutcome,
  type HttpResponseFacts,
  type ProtocolOutcome,
  type ProviderAnthropicCountTokensOutput,
  type ProviderAnthropicInput,
  type ProviderAnthropicMessagesOutput,
  type ProviderBaseOutput,
  type ProviderInput,
  type ProviderModelFacts,
  type ProviderOpenAIChatCompletionsOutput,
  type ProviderOpenAIResponsesOutput,
  type ProviderPipelines,
  type ProviderResponsesInput,
} from '@floway-dev/provider';

type ChatInput = ProviderInput<KimiCodeUpstreamFacts, Omit<OpenAIChatCompletionsPayloadEx, 'model'>>;
type MessagesInput = ProviderAnthropicInput<KimiCodeUpstreamFacts>;
type ResponsesInput = ProviderResponsesInput<KimiCodeUpstreamFacts>;
type RequestShape = ProviderInput<KimiCodeUpstreamFacts, object>;
type OpenAiRequest = ProviderInput<KimiCodeUpstreamFacts, { readonly service_tier?: string | null }>;
type Selected<Input> = Input & { readonly 'request.kimi.selection': KimiCodeModelSelection };
type ApiRejection = { readonly anthropic: boolean; readonly message: string };
type Route = KimiCodeModelSelection | ApiRejection;

const requestKeys = ['provider.upstream', 'provider.model', 'request.http', 'request.payload'] as const;
const bodyKeys = ['provider.upstream', 'request.payload', 'request.kimi.selection'] as const;
const responseKeys = ['response.http', 'response.modelKey'] as const;
const chatOutcome = 'response.openaiChatCompletions';
const responsesOutcome = 'response.openaiResponses';
const messagesOutcome = 'response.anthropicMessages';
const countOutcome = 'response.anthropicMessagesCountTokens';

const fastModeRequired = (model: ProviderModelFacts, field: 'service_tier' | 'speed'): ApiRejection => ({
  anthropic: field === 'speed',
  message: `'${model.id}' is only available with fast mode selected; set \`${field}: "${field === 'speed' ? 'fast' : FAST_SERVICE_TIER}"\`.`,
});

const selectOpenAi = (facts: OpenAiRequest): Route => {
  const model = facts['provider.model'];
  return selectKimiCodeModel(model, isFastServiceTier(facts['request.payload'].service_tier)) ?? fastModeRequired(model, 'service_tier');
};

const selectMessages = (facts: MessagesInput): Route => {
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

type OperationOutput<Key extends string> = ProviderBaseOutput & Readonly<Record<Key, ProtocolOutcome<unknown, unknown> | HttpOutcome>>;

const selectRequest = <Input extends RequestShape, Key extends string>(select: (facts: Input) => Route, key: Key) =>
  defineStage<Input, Selected<Input>, OperationOutput<Key>, OperationOutput<Key>>({
    name: 'selectModelLane',
    through: {
      request: { needs: ['provider.model', 'request.payload'], consumes: [], provides: ['request.kimi.selection'] },
      response: { needs: [], consumes: [], provides: [] },
    },
    return: { provides: [...responseKeys, key] },
    async execute(facts, scope) {
      const route = select(facts);
      if ('modelId' in route) return await scope.next({ ...facts, 'request.kimi.selection': route });
      const body = {
        ...(route.anthropic ? { type: 'error' } : {}),
        error: { type: 'invalid_request_error', message: route.message },
      };
      const now = scope.clock();
      return {
        'response.http': {
          status: 400,
          statusText: '',
          headers: [['content-type', 'application/json']],
          body: Bytes.fromUtf8(JSON.stringify(body)),
          timing: { startedAt: now, headersAt: now },
        },
        'response.modelKey': facts['provider.model'].upstreamModelId,
        [key]: { kind: 'error', source: 'local', error: body },
      } as OperationOutput<Key>;
    },
  });

type OutcomeFact<Key extends string, Event, Result> = Readonly<Record<Key, ProtocolOutcome<Event, Result>>>;

const annotateFrames = <Input, Key extends string, Event, Result = never>(
  key: Key,
  mapping: (facts: Selected<Input>) => ((event: Event) => Event) | undefined,
) => defineStage<
  Selected<Input>, Selected<Input>, OutcomeFact<Key, Event, Result>, OutcomeFact<Key, Event, Result>
>({
  name: 'annotateSpeed',
  through: {
    request: { needs: ['request.payload', 'request.kimi.selection'], consumes: [], provides: [] },
    response: { needs: [key], consumes: [], provides: [key] },
  },
  async execute(facts, scope) {
    const back = await scope.next(facts);
    const outcome = back[key];
    if (outcome.kind !== 'stream') return back;
    const map = mapping(facts);
    if (!map) return back;
    const events = scope.wrapStream(outcome.events, {
      label: 'kimi.speed',
      async *transform(source) {
        for await (const frame of source) yield frame.type === 'event' ? eventFrame(map(frame.event)) : frame;
      },
    });
    return { ...back, [key]: { ...outcome, events } };
  },
});

const selectedTier = (selection: KimiCodeModelSelection) => selection.lane === 'fast' ? FAST_SERVICE_TIER : 'default';

const annotateOpenAi = <Input extends OpenAiRequest, Key extends string, Event, Result = never>(
  key: Key,
  annotate: (event: Event, tier: 'priority' | 'default') => Event,
) => annotateFrames<Input, Key, Event, Result>(key, facts => {
  if (!isFastServiceTier(facts['request.payload'].service_tier)) return undefined;
  const tier = selectedTier(facts['request.kimi.selection']);
  return event => annotate(event, tier);
});

type ProbeInput = Pick<RequestShape, 'provider.upstream'>;
type HttpOutput = { readonly 'response.http': HttpResponseFacts };

const probeAfterResponse = defineStage<ProbeInput, ProbeInput, HttpOutput, HttpOutput, KimiCodeServices>({
  name: 'probeAfterResponse',
  through: {
    request: { needs: ['provider.upstream'], consumes: [], provides: [] },
    response: { needs: ['response.http'], consumes: [], provides: [] },
  },
  async execute(facts, scope) {
    const back = await scope.next(facts);
    if (back['response.http'].transportError !== undefined) return back;
    const upstream = facts['provider.upstream'];
    const { kimiCode, fetcher } = scope.services;
    const probes = await kimiCode.probeAfterResponse(upstream, back['response.http'].status, fetcher(upstream.id));
    for (const { kind, work } of probes) {
      scope.defer(`kimiCode.${kind}Probe`, work.then(
        () => ({ persisted: true }),
        (error: unknown) => {
          const warning = `Failed to refresh Kimi Code ${kind} for ${upstream.id}:`;
          console.warn(warning, error);
          const snapshot = snapshotError(error);
          scope.log.warn(warning, { error: snapshot });
          return { persisted: false, error: snapshot };
        },
      ));
    }
    return back;
  },
});

const requireGeneration = defineStage<ResponsesInput, ResponsesInput, {}, {}>({
  name: 'requireGeneration',
  through: {
    request: { needs: ['request.action'], consumes: [], provides: [] },
    response: { needs: [], consumes: [], provides: [] },
  },
  execute: transform(() => ({
    request: facts => {
      if (facts['request.action'] === 'compact') throw new Error('Kimi Code does not expose a native Responses compaction endpoint');
      return facts;
    },
  })),
});

const keepOpenAiHeader = (name: string) => name === 'authorization' || name === 'content-type';
const keepMessagesHeader = (name: string) => keepOpenAiHeader(name) || name === 'anthropic-version' || name === 'anthropic-beta';
const stripOpenAiHeaders = stripHttpHeaders(keepOpenAiHeader);
const stripMessagesHeaders = stripHttpHeaders(keepMessagesHeader);

const openAi = (path: string) => rewriteHttpRequestStage<Selected<OpenAiRequest>>('buildRequest', bodyKeys, facts => {
  const { config } = facts['provider.upstream'];
  const selection = facts['request.kimi.selection'];
  const payload = facts['request.payload'];
  const value = {
    ...payload,
    ...(isFastServiceTier(payload.service_tier) ? { service_tier: selectedTier(selection) } : {}),
    stream: true,
    model: selection.modelId,
  };
  return {
    modelKey: selection.modelId,
    request: {
      method: 'POST',
      url: httpUrl(kimiCodeUrl(config.region, path)),
      headers: [['authorization', secret(`Bearer ${config.apiKey.reveal()}`)]],
      body: { kind: 'json', value },
    },
  };
});

const messages = (stream: boolean) => rewriteHttpRequestStage<Selected<MessagesInput>>(
  'buildRequest', [...bodyKeys, 'request.anthropicBeta'], facts => {
    const { config } = facts['provider.upstream'];
    const modelKey = facts['request.kimi.selection'].modelId;
    const payload = kimiCodeMessagesWireBody(facts['request.payload']);
    const value = { ...payload, ...(stream ? { stream: true } : {}), model: modelKey };
    const authorization = secret(`Bearer ${config.apiKey.reveal()}`);
    return {
      modelKey,
      request: {
        method: 'POST',
        url: httpUrl(kimiCodeUrl(config.region, stream ? '/messages' : '/messages/count_tokens')),
        headers: current => setHeader(headersForAnthropicMessagesCall(current, facts['request.anthropicBeta']), 'authorization', authorization),
        body: { kind: 'json', value },
      },
    };
  },
);

// https://platform.claude.com/docs/en/api/errors#error-shapes
const messagesError = (message: string) => ({ type: 'error', error: { type: 'api_error', message } });
const messagesErrorFormat = {
  formatNonJsonError: (status: number, text: string) => messagesError(text || `Upstream returned HTTP ${status}`),
  formatNonStreamError: (status: number, contentType: string | undefined, snippet: string) =>
    messagesError(`Upstream returned HTTP ${status} with content-type "${contentType ?? 'unknown'}" but a text/event-stream body is required. Body: ${snippet}`),
};

// Thinking and effort are forwarded unchanged. Responses echo the requested
// model, including when Kimi routes a disabled-thinking request to another model.
// https://www.kimi.com/code/docs/en/kimi-code/models.html
export const kimiCodePipelines = {
  openaiChatCompletions: compose<ChatInput & ProviderOpenAIChatCompletionsOutput, KimiCodeServices>()('kimi-code.openaiChatCompletions', {
    entry: requestKeys,
    exit: [...responseKeys, chatOutcome],
    stages: [
      selectRequest(selectOpenAi, chatOutcome),
      annotateOpenAi<ChatInput, typeof chatOutcome, OpenAIChatCompletionsStreamEvent>(chatOutcome, withKimiCodeChatTier),
      parseSseStage('parseSse', chatOutcome, parseOpenAIChatCompletionsStream),
      probeAfterResponse,
      openAi('/chat/completions'),
      stripOpenAiHeaders,
    ],
    ending: httpTerminal,
  }),
  openaiResponses: compose<ResponsesInput & ProviderOpenAIResponsesOutput, KimiCodeServices>()('kimi-code.openaiResponses', {
    entry: [...requestKeys, 'request.action'],
    exit: [...responseKeys, responsesOutcome],
    stages: [
      requireGeneration,
      selectRequest(selectOpenAi, responsesOutcome),
      annotateOpenAi<ResponsesInput, typeof responsesOutcome, OpenAIResponsesStreamEventEx, OpenAIResponsesCompactionResultEx>(responsesOutcome, withKimiCodeResponsesTier),
      parseResponsesStage(),
      probeAfterResponse,
      openAi('/responses'),
      stripOpenAiHeaders,
    ],
    ending: httpTerminal,
  }),
  anthropicMessages: compose<MessagesInput & ProviderAnthropicMessagesOutput, KimiCodeServices>()('kimi-code.anthropicMessages', {
    entry: [...requestKeys, 'request.anthropicBeta'],
    exit: [...responseKeys, messagesOutcome],
    stages: [
      selectRequest(selectMessages, messagesOutcome),
      annotateFrames<MessagesInput, typeof messagesOutcome, AnthropicMessagesStreamEventEx>(messagesOutcome, facts => {
        const { speed } = facts['request.payload'];
        if (speed !== 'fast' && speed !== 'standard') return undefined;
        return event => withKimiCodeMessagesSpeed(event, speed === 'fast' ? 'fast' : 'standard');
      }),
      parseSseStage('parseSse', messagesOutcome, parseAnthropicMessagesStream, messagesErrorFormat),
      probeAfterResponse,
      messages(true),
      stripMessagesHeaders,
    ],
    ending: httpTerminal,
  }),
  anthropicMessagesCountTokens: compose<MessagesInput & ProviderAnthropicCountTokensOutput, KimiCodeServices>()('kimi-code.anthropicMessagesCountTokens', {
    entry: [...requestKeys, 'request.anthropicBeta'],
    exit: [...responseKeys, countOutcome],
    stages: [
      selectRequest(selectMessages, countOutcome),
      parseHttpOutcomeStage('parseCountTokens', countOutcome, messagesErrorFormat),
      messages(false),
      stripMessagesHeaders,
    ],
    ending: httpTerminal,
  }),
} satisfies ProviderPipelines<KimiCodeUpstreamFacts, KimiCodeServices>;
