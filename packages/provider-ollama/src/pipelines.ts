import { scheduleOllamaAccountProbe } from './account-probe.ts';
import type { OllamaUpstreamConfig } from './config.ts';
import type { OllamaUpstreamState } from './state.ts';
import { scheduleOllamaUsageProbe } from './usage-probe.ts';
import { defineRequestStage, defineStage, pipeline, secret } from '@floway-dev/pipeline';
import type { HeaderEntry, StageEnv } from '@floway-dev/pipeline';
import { parseAnthropicMessagesStream, type AnthropicMessagesStreamEventEx } from '@floway-dev/protocols/anthropic-messages';
import { DEFAULT_DECISION_PATHS, serializeDecisionRequest } from '@floway-dev/protocols/decision';
import { parseOpenAIChatCompletionsStream, type OpenAIChatCompletionsStreamEvent } from '@floway-dev/protocols/openai-chat-completions';
import { parseOpenAIResponsesStream, toCompactPayloadShape, type OpenAIResponsesCompactionResultEx, type OpenAIResponsesStreamEventEx } from '@floway-dev/protocols/openai-responses';
import {
  buildAudioTranscriptionMultipartBody,
  buildWireHttpUrl,
  httpTerminal,
  parseUpstreamSseOutcome,
  readManagedBytes,
  type HttpOutcome,
  type ProviderModelFacts,
  type ProviderPipelineAnthropicMessagesCountTokensInput,
  type ProviderPipelineAnthropicMessagesInput,
  type ProviderPipelineDecisionInput,
  type ProviderPipelineDecisionOutcome,
  type ProviderPipelineOpenAIAudioTranscriptionsInput,
  type ProviderPipelineOpenAIChatCompletionsInput,
  type ProviderPipelineOpenAICompletionsInput,
  type ProviderPipelineOpenAIEmbeddingsInput,
  type ProviderPipelineOpenAIResponsesInput,
  type ProviderPipelineResponsesOutcome,
  type ProviderPipelineServices,
  type ProviderPipelineStreamOutcome,
  type ProviderPipelines,
  type UpstreamHttpRequest,
  type UpstreamRecord,
} from '@floway-dev/provider';

type HttpFacts = {
  readonly 'request.http': UpstreamHttpRequest;
  readonly 'provider.modelKey': string;
};

type PipelineEnv = StageEnv<ProviderPipelineServices>;
type ChatOutcome = ProviderPipelineStreamOutcome<OpenAIChatCompletionsStreamEvent>;
type MessagesOutcome = ProviderPipelineStreamOutcome<AnthropicMessagesStreamEventEx>;

const rawModelIdOf = (model: ProviderModelFacts): string => model.providerData as string;

const headerEntry = (name: string, value: string): HeaderEntry => Object.freeze([name, value] as const);

const mergeHeaders = (base: readonly HeaderEntry[], overrides: readonly HeaderEntry[]): readonly HeaderEntry[] => {
  const overrideNames = new Set(overrides.map(([name]) => name.toLowerCase()));
  return Object.freeze([
    ...base.filter(([name]) => !overrideNames.has(name.toLowerCase())),
    ...overrides,
  ]);
};

const authHeaders = (config: OllamaUpstreamConfig): readonly HeaderEntry[] => config.apiKey
  ? Object.freeze([Object.freeze(['Authorization', secret(`Bearer ${config.apiKey}`)] as const)])
  : Object.freeze([]);

const openAIHeaders = (
  config: OllamaUpstreamConfig,
  inbound: readonly HeaderEntry[],
): readonly HeaderEntry[] => mergeHeaders(authHeaders(config), inbound);

const anthropicHeaders = (
  config: OllamaUpstreamConfig,
  inbound: readonly HeaderEntry[],
  beta: readonly string[],
): readonly HeaderEntry[] => {
  const ordinary = mergeHeaders(authHeaders(config), inbound)
    .filter(([name]) => name.toLowerCase() !== 'anthropic-beta');
  return beta.length === 0
    ? Object.freeze(ordinary)
    : Object.freeze([...ordinary, headerEntry('anthropic-beta', beta.join(','))]);
};

const jsonRequestFacts = (
  config: OllamaUpstreamConfig,
  modelKey: string,
  path: string,
  headers: readonly HeaderEntry[],
  value: object,
): HttpFacts => ({
  'request.http': {
    method: 'POST',
    url: buildWireHttpUrl(config.baseUrl, path),
    headers,
    body: { kind: 'json', value },
  },
  'provider.modelKey': modelKey,
});

const armProbes = (
  record: UpstreamRecord,
  config: OllamaUpstreamConfig,
  state: OllamaUpstreamState,
  env: PipelineEnv,
): void => {
  const fetcher = env.fetcherFor(record.id);
  scheduleOllamaUsageProbe(record.id, config, state, fetcher, env.waitUntil);
  scheduleOllamaAccountProbe(record.id, config, state, fetcher, env.waitUntil);
};

// Ollama reads only the legacy field and ignores max_completion_tokens.
// https://github.com/ollama/ollama/blob/9a4b136efefecb51b428d22e79b0f3d15769a1f8/openai/openai.go#L110-L125
// https://github.com/ollama/ollama/blob/9a4b136efefecb51b428d22e79b0f3d15769a1f8/openai/openai.go#L753-L755
const renameOutputCap = defineRequestStage<
  ProviderPipelineOpenAIChatCompletionsInput,
  { readonly 'request.payload': ProviderPipelineOpenAIChatCompletionsInput['request.payload'] },
  'request.payload',
  ProviderPipelineServices
>({
  name: 'renameOutputCap',
  consumes: ['request.payload'],
  provides: ['request.payload'],
  execute: async (facts, next) => {
    const payload = facts['request.payload'];
    const cap = payload.max_completion_tokens;
    if (cap === undefined || payload.max_tokens !== undefined) return await next({ 'request.payload': payload });
    const { max_completion_tokens: _maxCompletionTokens, ...rest } = payload;
    return await next({ 'request.payload': { ...rest, max_tokens: cap } });
  },
});

const openaiCompletions = (
  record: UpstreamRecord,
  config: OllamaUpstreamConfig,
  state: OllamaUpstreamState,
) => defineStage<ProviderPipelineOpenAICompletionsInput, HttpFacts, HttpOutcome, HttpOutcome, never, ProviderPipelineServices>({
  name: 'ollama.openai-completions.request',
  provides: ['request.http', 'provider.modelKey'],
  execute: async (facts, next, env) => {
    const modelKey = rawModelIdOf(facts['provider.model']);
    const http = await next(jsonRequestFacts(
      config,
      modelKey,
      '/v1/completions',
      openAIHeaders(config, facts['request.inboundHeaders']),
      { ...facts['request.payload'], model: modelKey },
    ));
    armProbes(record, config, state, env);
    return http;
  },
});

const openaiChatCompletions = (
  record: UpstreamRecord,
  config: OllamaUpstreamConfig,
  state: OllamaUpstreamState,
) => defineStage<ProviderPipelineOpenAIChatCompletionsInput, HttpFacts, HttpOutcome, ChatOutcome, never, ProviderPipelineServices>({
  name: 'ollama.openai-chat-completions.request',
  provides: ['request.http', 'provider.modelKey'],
  execute: async (facts, next, env) => {
    const modelKey = rawModelIdOf(facts['provider.model']);
    const http = await next(jsonRequestFacts(
      config,
      modelKey,
      '/v1/chat/completions',
      openAIHeaders(config, facts['request.inboundHeaders']),
      { ...facts['request.payload'], stream: true, model: modelKey },
    ));
    armProbes(record, config, state, env);
    return await parseUpstreamSseOutcome(http, parseOpenAIChatCompletionsStream, env);
  },
});

const openaiResponses = (
  record: UpstreamRecord,
  config: OllamaUpstreamConfig,
  state: OllamaUpstreamState,
) => defineStage<ProviderPipelineOpenAIResponsesInput, HttpFacts, HttpOutcome, ProviderPipelineResponsesOutcome, never, ProviderPipelineServices>({
  name: 'ollama.openai-responses.request',
  provides: ['request.http', 'provider.modelKey'],
  execute: async (facts, next, env) => {
    const modelKey = rawModelIdOf(facts['provider.model']);
    const headers = openAIHeaders(config, facts['request.inboundHeaders']);
    if (facts['request.action'] === 'generate') {
      const http = await next(jsonRequestFacts(
        config,
        modelKey,
        '/v1/responses',
        headers,
        { ...facts['request.payload'], stream: true, model: modelKey },
      ));
      armProbes(record, config, state, env);
      return {
        action: 'generate',
        ...await parseUpstreamSseOutcome<OpenAIResponsesStreamEventEx>(http, parseOpenAIResponsesStream, env),
      };
    }

    const http = await next(jsonRequestFacts(
      config,
      modelKey,
      '/v1/responses/compact',
      headers,
      { ...toCompactPayloadShape(facts['request.payload']), model: modelKey },
    ));
    armProbes(record, config, state, env);
    if (http.status < 200 || http.status >= 300) return { action: 'compact', ok: false, modelKey, http };
    const bytes = await readManagedBytes(http.body);
    const result = JSON.parse(new TextDecoder().decode(bytes)) as OpenAIResponsesCompactionResultEx;
    return {
      action: 'compact',
      ok: true,
      result,
      modelKey,
      http: {
        status: http.status,
        statusText: http.statusText,
        headers: http.headers,
        timing: http.timing,
      },
    };
  },
});

const anthropicMessages = (
  record: UpstreamRecord,
  config: OllamaUpstreamConfig,
  state: OllamaUpstreamState,
) => defineStage<ProviderPipelineAnthropicMessagesInput, HttpFacts, HttpOutcome, MessagesOutcome, never, ProviderPipelineServices>({
  name: 'ollama.anthropic-messages.request',
  provides: ['request.http', 'provider.modelKey'],
  execute: async (facts, next, env) => {
    const modelKey = rawModelIdOf(facts['provider.model']);
    const http = await next(jsonRequestFacts(
      config,
      modelKey,
      '/v1/messages',
      anthropicHeaders(config, facts['request.inboundHeaders'], facts['request.anthropicBeta']),
      { ...facts['request.payload'], stream: true, model: modelKey },
    ));
    armProbes(record, config, state, env);
    return await parseUpstreamSseOutcome(http, parseAnthropicMessagesStream, env);
  },
});

const anthropicMessagesCountTokens = (
  config: OllamaUpstreamConfig,
) => defineStage<ProviderPipelineAnthropicMessagesCountTokensInput, HttpFacts, HttpOutcome, HttpOutcome, never, ProviderPipelineServices>({
  name: 'ollama.anthropic-messages-count-tokens.request',
  provides: ['request.http', 'provider.modelKey'],
  execute: async (facts, next) => {
    const modelKey = rawModelIdOf(facts['provider.model']);
    return await next(jsonRequestFacts(
      config,
      modelKey,
      '/v1/messages/count_tokens',
      anthropicHeaders(config, facts['request.inboundHeaders'], facts['request.anthropicBeta']),
      { ...facts['request.payload'], model: modelKey },
    ));
  },
});

const openaiEmbeddings = (
  record: UpstreamRecord,
  config: OllamaUpstreamConfig,
  state: OllamaUpstreamState,
) => defineStage<ProviderPipelineOpenAIEmbeddingsInput, HttpFacts, HttpOutcome, HttpOutcome, never, ProviderPipelineServices>({
  name: 'ollama.openai-embeddings.request',
  provides: ['request.http', 'provider.modelKey'],
  execute: async (facts, next, env) => {
    const modelKey = rawModelIdOf(facts['provider.model']);
    const http = await next(jsonRequestFacts(
      config,
      modelKey,
      '/v1/embeddings',
      openAIHeaders(config, facts['request.inboundHeaders']),
      { ...facts['request.payload'], model: modelKey },
    ));
    armProbes(record, config, state, env);
    return http;
  },
});

const openaiAudioTranscriptions = (
  record: UpstreamRecord,
  config: OllamaUpstreamConfig,
  state: OllamaUpstreamState,
) => defineStage<ProviderPipelineOpenAIAudioTranscriptionsInput, HttpFacts, HttpOutcome, HttpOutcome, never, ProviderPipelineServices>({
  name: 'ollama.openai-audio-transcriptions.request',
  provides: ['request.http', 'provider.modelKey'],
  execute: async (facts, next, env) => {
    const modelKey = rawModelIdOf(facts['provider.model']);
    const http = await next({
      'request.http': {
        method: 'POST',
        url: buildWireHttpUrl(config.baseUrl, '/v1/audio/transcriptions'),
        headers: openAIHeaders(config, facts['request.inboundHeaders']),
        body: buildAudioTranscriptionMultipartBody(facts['request.payload'], { type: 'replace', value: modelKey }),
      },
      'provider.modelKey': modelKey,
    });
    armProbes(record, config, state, env);
    return http;
  },
});

const decision = (
  config: OllamaUpstreamConfig,
) => defineStage<ProviderPipelineDecisionInput, HttpFacts, HttpOutcome, ProviderPipelineDecisionOutcome, never, ProviderPipelineServices>({
  name: 'ollama.decision.request',
  provides: ['request.http', 'provider.modelKey'],
  execute: async (facts, next) => {
    const target = facts['provider.model'].decisionTarget;
    if (target === undefined) throw new Error(`Decision model ${facts['provider.model'].id} has no outbound target`);
    const modelKey = rawModelIdOf(facts['provider.model']);
    const http = await next(jsonRequestFacts(
      config,
      modelKey,
      target.path ?? DEFAULT_DECISION_PATHS[target.protocol],
      openAIHeaders(config, facts['request.inboundHeaders']),
      serializeDecisionRequest(target.protocol, modelKey, facts['request.payload']),
    ));
    return { target, modelKey, http };
  },
});

export const createOllamaPipelines = (
  record: UpstreamRecord,
  config: OllamaUpstreamConfig,
  state: OllamaUpstreamState,
): ProviderPipelines => ({
  openaiCompletions: pipeline<ProviderPipelineOpenAICompletionsInput>('ollama.openaiCompletions')
    .use(openaiCompletions(record, config, state))
    .end(httpTerminal(record.id)),
  openaiChatCompletions: pipeline<ProviderPipelineOpenAIChatCompletionsInput>('ollama.openaiChatCompletions')
    .use(renameOutputCap)
    .use(openaiChatCompletions(record, config, state))
    .end(httpTerminal(record.id)),
  openaiResponses: pipeline<ProviderPipelineOpenAIResponsesInput>('ollama.openaiResponses')
    .use(openaiResponses(record, config, state))
    .end(httpTerminal(record.id)),
  anthropicMessages: pipeline<ProviderPipelineAnthropicMessagesInput>('ollama.anthropicMessages')
    .use(anthropicMessages(record, config, state))
    .end(httpTerminal(record.id)),
  anthropicMessagesCountTokens: pipeline<ProviderPipelineAnthropicMessagesCountTokensInput>('ollama.anthropicMessagesCountTokens')
    .use(anthropicMessagesCountTokens(config))
    .end(httpTerminal(record.id)),
  openaiEmbeddings: pipeline<ProviderPipelineOpenAIEmbeddingsInput>('ollama.openaiEmbeddings')
    .use(openaiEmbeddings(record, config, state))
    .end(httpTerminal(record.id)),
  openaiAudioTranscriptions: pipeline<ProviderPipelineOpenAIAudioTranscriptionsInput>('ollama.openaiAudioTranscriptions')
    .use(openaiAudioTranscriptions(record, config, state))
    .end(httpTerminal(record.id)),
  decision: pipeline<ProviderPipelineDecisionInput>('ollama.decision')
    .use(decision(config))
    .end(httpTerminal(record.id)),
});
