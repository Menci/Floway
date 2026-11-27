// Ollama provider. Builds a UpstreamModel catalog from /api/tags + /api/show
// (see fetch-models.ts) and routes inference through Ollama's OpenAI-/
// Anthropic-compat shims at /v1/chat/completions, /v1/responses, /v1/messages,
// /v1/completions, /v1/embeddings, /v1/audio/transcriptions — the same paths the cloud (ollama.com) and
// self-hosted Ollama daemons share. Authentication is a single optional
// bearer token.
//
// Capability → endpoints mapping:
//   capabilities includes "embedding" → kind: 'embedding',
//                                       endpoints: { openaiEmbeddings: {} }
//   otherwise (chat / vision / tools / thinking) → kind: 'chat',
//                                       endpoints: { openaiCompletions, openaiChatCompletions, openaiResponses, anthropicMessages }
//
// Vision, tool calling, and reasoning/thinking are request-time features, not
// per-endpoint capabilities, so they do not change routing. They surface to
// the dashboard via the model's `chat` field for display purposes only.
//
// Audio has no dedicated /api/show capability. The transcription route is
// therefore available only to manual config.models[] entries declaring the
// semantic endpoint; ordinary catalog rows stay chat/embedding.
// https://github.com/ollama/ollama/blob/573386c35eac76124ffce571f4b0fefa0a7fe13c/middleware/openai.go#L682-L789
//
// Manual config.models[] entries are emitted ahead of the auto-fetched
// catalog, and an auto row carrying the same upstreamModelId is dropped so the
// manual copy is the only one for that id.

import { scheduleOllamaAccountProbe } from './account-probe.ts';
import { chatFromOllamaRaw } from './chat-from-raw.ts';
import { assertOllamaUpstreamRecord, type OllamaUpstreamConfig } from './config.ts';
import { OLLAMA_DEFAULT_FLAGS } from './defaults.ts';
import { fetchOllamaCatalog, type OllamaCatalog } from './fetch-models.ts';
import { ollamaFetchDecision, ollamaFetchOpenAIAudioTranscriptions, ollamaFetchOpenAIChatCompletions, ollamaFetchOpenAICompletions, ollamaFetchOpenAIEmbeddings, ollamaFetchAnthropicMessages, ollamaFetchAnthropicMessagesCountTokens, ollamaFetchOpenAIResponses, ollamaFetchOpenAIResponsesCompact } from './fetch.ts';
import { OLLAMA_OPENAI_CHAT_COMPLETIONS_BOUNDARY } from './interceptors/openai-chat-completions/index.ts';
import type { OpenAIChatCompletionsBoundaryCtx } from './interceptors/openai-chat-completions/types.ts';
import { pricingForOllamaModelKey } from './pricing.ts';
import { readOllamaUpstreamState } from './state.ts';
import { scheduleOllamaUsageProbe, runOllamaScheduledTask } from './usage-probe.ts';
import { runInterceptors } from '@floway-dev/interceptor';
import { parseAnthropicMessagesStream } from '@floway-dev/protocols/anthropic-messages';
import { type ModelEndpoints, kindForEndpoints } from '@floway-dev/protocols/common';
import { DEFAULT_DECISION_PATHS, serializeDecisionRequest, type CanonicalDecisionRequest } from '@floway-dev/protocols/decision';
import { parseOpenAIChatCompletionsStream } from '@floway-dev/protocols/openai-chat-completions';
import { parseOpenAIResponsesStream, type OpenAIResponsesCompactionResultEx, toCompactPayloadShape } from '@floway-dev/protocols/openai-responses';
import { headersForAnthropicMessagesCall, jsonRequestBody, publicModelId, resolveEffectiveFlags, serializeModelFieldOpenAIAudioTranscriptionRequest, streamingUpstreamCall, type FetchInit, type FlagId, type HttpHeaderLines, type UpstreamInstance, type Upstream, type UpstreamCallResult, type UpstreamModel, type UpstreamStreamParser, type UpstreamCallOptions, type UpstreamFetchOptions, type UpstreamModelConfig, type UpstreamRecord } from '@floway-dev/upstream';

// upstreamData carries the raw upstream id verbatim — the same value /api/tags
// returns and the same value the gateway must send back on every inference call.
const rawModelIdOf = (model: UpstreamModel): string => model.upstreamData as string;

// Vision / tool / thinking capabilities live alongside `embedding` in the
// /api/show response. Embedding is the only one that drives a different
// kind/endpoints projection — the others are request-time signals.
const CHAT_ENDPOINTS: ModelEndpoints = { openaiCompletions: {}, openaiChatCompletions: {}, openaiResponses: {}, anthropicMessages: {} };
const EMBEDDING_ENDPOINTS: ModelEndpoints = { openaiEmbeddings: {} };
// Ollama serves decision models over the System One contract.
// https://docs.ollama.com/capabilities/decision
const DECISION_ENDPOINTS: ModelEndpoints = { decision: {} };

const finalizeOllamaModels = (
  catalog: OllamaCatalog,
  enabledFlags: ReadonlySet<FlagId>,
): UpstreamModel[] => {
  const models: UpstreamModel[] = [];
  for (const raw of catalog.data) {
    const endpoints = raw.capabilities.has('embedding')
      ? EMBEDDING_ENDPOINTS
      : raw.capabilities.has('decision') ? DECISION_ENDPOINTS : CHAT_ENDPOINTS;
    const limits: UpstreamModel['limits'] = {};
    if (raw.contextLength !== undefined) limits.max_context_window_tokens = raw.contextLength;
    const model: UpstreamModel = {
      id: raw.id,
      upstreamModelId: raw.id,
      owned_by: 'ollama',
      limits,
      kind: kindForEndpoints(endpoints),
      endpoints,
      upstreamData: raw.id,
      enabledFlags,
      opaqueBlobCompatibilityScope: { bindToUpstream: true },
      ...(endpoints.decision ? { decisionTarget: { protocol: 'typesafe-systemone' as const } } : {}),
    };
    if (raw.modifiedAt !== undefined) model.created = raw.modifiedAt;
    const pricing = pricingForOllamaModelKey(raw.id);
    if (pricing) model.pricing = pricing;
    const chat = chatFromOllamaRaw(raw);
    if (chat) model.chat = chat;
    models.push(model);
  }
  return models;
};

export const projectOllamaManualModels = (
  record: UpstreamRecord,
  manualModels: readonly UpstreamModelConfig[],
): UpstreamModel[] => {
  assertOllamaUpstreamRecord(record);
  return manualModels.map(model => {
    const enabledFlags = resolveEffectiveFlags([OLLAMA_DEFAULT_FLAGS, record.flagOverrides, model.flagOverrides]);
    const endpoints = model.endpoints;
    const kind = kindForEndpoints(endpoints);
    const internal: UpstreamModel = {
      id: publicModelId(model),
      upstreamModelId: model.upstreamModelId,
      limits: { ...(model.limits ?? {}) },
      kind,
      endpoints,
      upstreamData: model.upstreamModelId,
      enabledFlags,
      opaqueBlobCompatibilityScope: model.opaqueBlobCompatibilityScope ?? { bindToUpstream: true },
      // Ollama serves every decision model over System One; the dialect is not
      // the operator's to choose.
      ...(kind === 'decision' ? { decisionTarget: { protocol: 'typesafe-systemone' as const } } : {}),
    };
    if (model.display_name !== undefined) internal.display_name = model.display_name;
    const pricing = model.pricing ?? pricingForOllamaModelKey(model.upstreamModelId);
    if (pricing) internal.pricing = pricing;
    if (kind === 'chat' && model.chat) internal.chat = model.chat;
    return internal;
  });
};

export const createOllamaUpstream = (record: UpstreamRecord): Upstream => {
  const { config } = assertOllamaUpstreamRecord(record);
  const upstreamFlags = resolveEffectiveFlags([OLLAMA_DEFAULT_FLAGS, record.flagOverrides]);
  const state = readOllamaUpstreamState(record.state);

  // Cloud inference arms a paired usage/balance refresh. Account identity has
  // its own longer cadence. Token counting consumes neither, so it arms neither.
  const armProbes = (opts: UpstreamCallOptions): void => {
    scheduleOllamaUsageProbe(record.id, config, state, opts.fetcher, opts.waitUntil);
    scheduleOllamaAccountProbe(record.id, config, state, opts.fetcher, opts.waitUntil);
  };

  // Rate-limited responses also trigger a refresh so the balances explaining
  // the refusal can appear in the dashboard.
  const withProbes = <T>(opts: UpstreamCallOptions, dispatched: Promise<T>): Promise<T> =>
    dispatched.then(result => {
      armProbes(opts);
      return result;
    });
  const call = (
    transport: (config: OllamaUpstreamConfig, init: FetchInit, options: UpstreamFetchOptions) => Promise<Response>,
    model: UpstreamModel,
    body: Record<string, unknown>,
    signal: AbortSignal | undefined,
    headers: HttpHeaderLines,
    opts: UpstreamCallOptions,
  ): Promise<UpstreamCallResult> => {
    const rawModelId = rawModelIdOf(model);
    return transport(
      config,
      { method: 'POST', body: jsonRequestBody({ ...body, model: rawModelId }), signal },
      { extraHeaders: headers, fetcher: opts.fetcher, wrapUpstreamCall: opts.wrapUpstreamCall },
    ).then(response => ({ http: response, modelKey: rawModelId }));
  };

  const callStreaming = <TEvent>(
    transport: (config: OllamaUpstreamConfig, init: FetchInit, options: UpstreamFetchOptions) => Promise<Response>,
    model: UpstreamModel,
    body: Record<string, unknown>,
    signal: AbortSignal | undefined,
    headers: HttpHeaderLines,
    parser: UpstreamStreamParser<TEvent>,
    opts: UpstreamCallOptions,
  ) => {
    const rawModelId = rawModelIdOf(model);
    return streamingUpstreamCall(
      transport(
        config,
        { method: 'POST', body: jsonRequestBody({ ...body, stream: true, model: rawModelId }), signal },
        { extraHeaders: headers, fetcher: opts.fetcher, wrapUpstreamCall: opts.wrapUpstreamCall },
      ),
      parser,
      rawModelId,
      signal,
    );
  };

  const rejectUnsupported = (capability: string) => () =>
    Promise.reject(new Error(`Ollama upstream does not implement ${capability}`));

  const instance: UpstreamInstance = {
    runScheduledTask: options => runOllamaScheduledTask(record, options),
    callAlphaSearch: rejectUnsupported('callAlphaSearch'),
    callGeminiGenerateContent: rejectUnsupported('callGeminiGenerateContent'),
    callGeminiGenerateContentCountTokens: rejectUnsupported('callGeminiGenerateContentCountTokens'),
    getModels: async (fetcher, manualModels = []) => {
      const catalog = await fetchOllamaCatalog(config, fetcher);
      const overriddenIds = new Set(manualModels.map(m => m.upstreamModelId));
      const projectedManual = projectOllamaManualModels(record, manualModels);
      const auto = finalizeOllamaModels(
        { data: catalog.data.filter(raw => !overriddenIds.has(raw.id)) },
        upstreamFlags,
      );
      return [...projectedManual, ...auto];
    },
    callOpenAICompletions: (model, body, signal, opts) => withProbes(opts, call(ollamaFetchOpenAICompletions, model, body, signal, [...opts.headers], opts)),
    callOpenAIChatCompletions: async (model, body, signal, opts) => {
      const ctx: OpenAIChatCompletionsBoundaryCtx = { payload: body, model };
      return await withProbes(opts, runInterceptors(
        ctx, {}, OLLAMA_OPENAI_CHAT_COMPLETIONS_BOUNDARY,
        async () => await callStreaming(ollamaFetchOpenAIChatCompletions, model, ctx.payload, signal, [...opts.headers], parseOpenAIChatCompletionsStream, opts),
      ));
    },
    callOpenAIResponses: async (model, body, action, signal, opts) => {
      switch (action) {
      case 'generate': {
        const stream = await withProbes(opts, callStreaming(ollamaFetchOpenAIResponses, model, body, signal, [...opts.headers], parseOpenAIResponsesStream, opts));
        return { action: 'generate', ...stream };
      }
      case 'compact': {
        const rawModelId = rawModelIdOf(model);
        const response = await withProbes(opts, ollamaFetchOpenAIResponsesCompact(
          config,
          { method: 'POST', body: jsonRequestBody({ ...toCompactPayloadShape(body), model: rawModelId }), signal },
          { extraHeaders: [...opts.headers], fetcher: opts.fetcher, wrapUpstreamCall: opts.wrapUpstreamCall },
        ));
        return response.ok
          ? { action: 'compact', ok: true, result: (await response.json()) as OpenAIResponsesCompactionResultEx, modelKey: rawModelId, http: { status: response.status, headers: response.headers } }
          : { action: 'compact', ok: false, http: response, modelKey: rawModelId };
      }
      default:
        action satisfies never;
        throw new Error(`Unhandled OpenAIResponsesAction: ${action as string}`);
      }
    },
    callAnthropicMessages: (model, body, signal, opts) => withProbes(opts, callStreaming(ollamaFetchAnthropicMessages, model, body, signal, headersForAnthropicMessagesCall([...opts.headers], opts.anthropicBeta), parseAnthropicMessagesStream, opts)),
    callAnthropicMessagesCountTokens: (model, body, signal, opts) => call(ollamaFetchAnthropicMessagesCountTokens, model, body, signal, headersForAnthropicMessagesCall([...opts.headers], opts.anthropicBeta), opts),
    callOpenAIEmbeddings: (model, body, signal, opts) => withProbes(opts, call(ollamaFetchOpenAIEmbeddings, model, body, signal, [...opts.headers], opts)),
    // Ollama serves no image-generation endpoint; reject if the gateway ever
    // routes one here. /v1/images/* is not exposed by the upstream binary.
    callOpenAIImagesGenerations: rejectUnsupported('callOpenAIImagesGenerations'),
    callOpenAIImagesEdits: rejectUnsupported('callOpenAIImagesEdits'),
    callOpenAIAudioTranscriptions: async (model, request, signal, opts) => {
      const rawModelId = rawModelIdOf(model);
      const body = serializeModelFieldOpenAIAudioTranscriptionRequest(request, rawModelId);
      const response = await withProbes(opts, ollamaFetchOpenAIAudioTranscriptions(config, { method: 'POST', body, signal }, { extraHeaders: [...opts.headers], fetcher: opts.fetcher, wrapUpstreamCall: opts.wrapUpstreamCall }));
      return { http: response, modelKey: rawModelId };
    },
    callRerank: rejectUnsupported('callRerank'),
    callDecision: async (model: UpstreamModel, request: CanonicalDecisionRequest, signal: AbortSignal | undefined, opts: UpstreamCallOptions) => {
      const target = model.decisionTarget;
      if (target === undefined) throw new Error(`Decision model ${model.id} has no outbound target`);
      const rawModelId = rawModelIdOf(model);
      const body = serializeDecisionRequest(target.protocol, rawModelId, request);
      const response = await ollamaFetchDecision(
        config,
        target.path ?? DEFAULT_DECISION_PATHS[target.protocol],
        { method: 'POST', body: jsonRequestBody(body), signal },
        { extraHeaders: [...opts.headers], fetcher: opts.fetcher, wrapUpstreamCall: opts.wrapUpstreamCall },
      );
      return { http: response, modelKey: rawModelId, target };
    },
  };

  return {
    upstreamId: record.id,
    kind: 'ollama',
    name: record.name,
    inboundHeaderAllowlist: [],
    instance,
  };
};
