import { chatFromCopilotRaw } from './chat-from-raw.ts';
import { assertCopilotUpstreamRecord } from './config.ts';
import { fetchCopilotModels } from './fetch-models.ts';
import { copilotFetchChatCompletions, copilotFetchEmbeddings, copilotFetchMessages, copilotFetchMessagesCountTokens, copilotFetchResponses } from './fetch.ts';
import { COPILOT_CHATCOMPLETIONS_BOUNDARY } from './interceptors/chat-completions/index.ts';
import type { ChatCompletionsBoundaryCtx } from './interceptors/chat-completions/types.ts';
import { COPILOT_MESSAGES_BOUNDARY, COPILOT_MESSAGES_COUNT_TOKENS_BOUNDARY } from './interceptors/messages/index.ts';
import type { MessagesBoundaryCtx, MessagesCountTokensBoundaryCtx } from './interceptors/messages/types.ts';
import { COPILOT_RESPONSES_BOUNDARY } from './interceptors/responses/index.ts';
import type { ResponsesBoundaryCtx } from './interceptors/responses/types.ts';
import { emptyKnownModels, mergeKnownModels, projectKnownModels } from './known-models.ts';
import { mergeClaudeVariants } from './merge-claude-variants.ts';
import { copilotPublicModelId } from './model-name.ts';
import { CONTEXT_1M_BETA, copilotModelSupportsFastMode, type ModelSelectionHints, resolveCopilotRawModel } from './model-selection.ts';
import { pricingForCopilotModelKey, pricingForCopilotPublicModelId } from './pricing.ts';
import { readCopilotUpstreamState, type CopilotUpstreamState } from './state.ts';
import type { CopilotRawModel } from './types.ts';
import { runInterceptors } from '@floway-dev/interceptor';
import { parseChatCompletionsStream, type ChatCompletionsPayload, type ChatCompletionsStreamEvent } from '@floway-dev/protocols/chat-completions';
import { type ModelEndpointKey, type ModelEndpoints, type ProtocolFrame, kindForEndpoints } from '@floway-dev/protocols/common';
import { parseAnthropicBetaHeader, parseMessagesStream, type MessagesPayload, type MessagesStreamEvent } from '@floway-dev/protocols/messages';
import { parseResponsesStream, type ResponsesInputItem, type ResponsesPayload, type ResponsesResult } from '@floway-dev/protocols/responses';
import { COMPACTION_TRIGGER, compactionResponse, eventResult, getProviderRepo, readUpstreamApiError, streamingProviderCall, apiErrorToResponse, defaultsForProvider, resolveEffectiveFlags, type ExecuteResult, type ModelProvider, type ModelProviderInstance, type ProviderCallResult, type ProviderResponsesResult, type ProviderStreamResult, type TelemetryModelIdentity, type UpstreamCallOptions, type UpstreamFetchOptions, type UpstreamModel, type UpstreamRecord } from '@floway-dev/provider';

interface CopilotProviderData {
  rawModels: CopilotRawModel[];
}

// Project Copilot's raw `/models` shape into the slim provider-neutral fields
// shared by every provider. kind/endpoints/providerData/enabledFlags are added
// by the caller because they depend on Copilot's endpoint knowledge and the
// upstream-level flag layer.
const copilotInternalModel = (model: CopilotRawModel): Omit<UpstreamModel, 'kind' | 'endpoints' | 'providerData' | 'enabledFlags'> => {
  const limits: UpstreamModel['limits'] = {};
  if (model.capabilities?.limits?.max_output_tokens !== undefined) limits.max_output_tokens = model.capabilities.limits.max_output_tokens;
  if (model.capabilities?.limits?.max_context_window_tokens !== undefined) limits.max_context_window_tokens = model.capabilities.limits.max_context_window_tokens;
  if (model.capabilities?.limits?.max_prompt_tokens !== undefined) limits.max_prompt_tokens = model.capabilities.limits.max_prompt_tokens;

  const internal: Omit<UpstreamModel, 'kind' | 'endpoints' | 'providerData' | 'enabledFlags'> = {
    id: model.id,
    limits,
  };
  if (model.owned_by !== undefined) internal.owned_by = model.owned_by;
  if (model.created !== undefined) internal.created = model.created;
  const displayName = model.display_name ?? model.name;
  if (displayName !== undefined) internal.display_name = displayName;
  const chat = chatFromCopilotRaw(model);
  if (chat !== undefined) internal.chat = chat;
  return internal;
};

// Copilot's `/models` reports each model's served endpoints as public paths; map
// one onto our structured endpoint key. Both `/x` and `/v1/x` spellings appear.
// Copilot is the only upstream whose catalog speaks paths — operator config and
// our own constants are structured — so this lives here, not in a shared helper.
const copilotPathToModelEndpoint = (path: string): ModelEndpointKey | undefined => {
  switch (path) {
  case '/chat/completions':
  case '/v1/chat/completions':
    return 'chatCompletions';
  case '/responses':
  case '/v1/responses':
    return 'responses';
  case '/v1/messages':
  case '/messages':
    return 'messages';
  case '/embeddings':
  case '/v1/embeddings':
    return 'embeddings';
  case '/images/generations':
  case '/v1/images/generations':
    return 'imagesGenerations';
  case '/images/edits':
  case '/v1/images/edits':
    return 'imagesEdits';
  default:
    return undefined;
  }
};

const rawModelSupportsEndpoint = (model: CopilotRawModel, endpoint: ModelEndpointKey): boolean => {
  if ((model.supported_endpoints ?? []).some(path => copilotPathToModelEndpoint(path) === endpoint)) return true;
  // Copilot's Anthropic-family entries have historically under-reported their
  // native Messages path, so treat claude-* as Messages-capable.
  if (endpoint === 'messages' && model.id.startsWith('claude-')) return true;
  if (endpoint === 'chatCompletions') {
    return model.supported_endpoints === undefined && model.capabilities?.type === 'chat';
  }
  if (endpoint === 'embeddings') return model.supported_endpoints === undefined && model.capabilities?.type === 'embeddings';
  return false;
};

const copilotModelEndpoints = (publicModel: CopilotRawModel, rawModels: readonly CopilotRawModel[]): ModelEndpoints => {
  if (rawModels.some(model => rawModelSupportsEndpoint(model, 'responses'))) {
    return { responses: {} };
  }

  if (publicModel.id.startsWith('claude-') || rawModels.some(model => rawModelSupportsEndpoint(model, 'messages'))) {
    return { messages: {} };
  }

  if (rawModels.some(model => rawModelSupportsEndpoint(model, 'chatCompletions'))) {
    return { chatCompletions: {} };
  }

  return rawModels.some(model => rawModelSupportsEndpoint(model, 'embeddings')) ? { embeddings: {} } : {};
};

const chatReasoningEffort = (body: Omit<ChatCompletionsPayload, 'model'>): string | undefined => (body.reasoning_effort && body.reasoning_effort !== 'none' ? body.reasoning_effort : undefined);

const messagesReasoningEffort = (body: Omit<MessagesPayload, 'model'>): string | undefined => body.output_config?.effort;

const responsesReasoningEffort = (body: Omit<ResponsesPayload, 'model'>): string | undefined => (body.reasoning?.effort && body.reasoning.effort !== 'none' ? body.reasoning.effort : undefined);

const rejectUnsupported = (capability: string) => (): Promise<never> =>
  Promise.reject(new Error(`Copilot provider does not implement ${capability}`));

const rawModelFor = (model: UpstreamModel, endpoint: ModelEndpointKey, hints: ModelSelectionHints = {}): CopilotRawModel => {
  // Copilot exposes one canonical public Claude model id per family. Raw
  // variant selection is derived from request fields such as reasoning effort
  // and anthropic-beta, not from the client's original model alias string.
  const rawModels = (model.providerData as CopilotProviderData).rawModels.filter(rawModel => rawModelSupportsEndpoint(rawModel, endpoint));
  if (rawModels.length === 0) {
    throw new Error(`Copilot provider exposed ${endpoint} for ${model.id}, but no raw variant supports that endpoint`);
  }
  return resolveCopilotRawModel({ object: 'list', data: rawModels }, model.id, hints) ?? rawModels[0];
};

const copilotEmbeddingsBody = (body: Record<string, unknown>): Record<string, unknown> => {
  if (typeof body.input !== 'string') return body;

  // OpenAI-compatible clients may send scalar string input, but Copilot's
  // upstream /embeddings endpoint currently returns 400 unless text input is
  // wrapped as an array.
  // References:
  // https://platform.openai.com/docs/api-reference/embeddings/create
  // https://github.com/ericc-ch/copilot-api/blob/0ea08febdd7e3e055b03dd298bf57e669500b5c1/src/services/copilot/create-embeddings.ts#L19-L21
  // https://github.com/BerriAI/litellm/blob/c8fb77f119ad69a80f5fde088efd3a1aa77f458b/litellm/proxy/proxy_server.py#L7826-L7839
  return { ...body, input: [body.input] };
};

const finalizeCopilotModels = (rawModels: CopilotRawModel[], enabledFlags: ReadonlySet<string>): UpstreamModel[] => {
  const merged = mergeClaudeVariants({ object: 'list', data: rawModels });
  const groups = new Map<string, CopilotRawModel[]>();
  for (const rawModel of rawModels) {
    const id = copilotPublicModelId(rawModel.id);
    groups.set(id, [...(groups.get(id) ?? []), rawModel]);
  }

  const models: UpstreamModel[] = [];
  for (const mergedModel of merged.data) {
    const variants = groups.get(mergedModel.id) ?? [mergedModel];
    const endpoints = copilotModelEndpoints(mergedModel, variants);
    const cost = pricingForCopilotPublicModelId(mergedModel.id);
    models.push({
      ...copilotInternalModel(mergedModel),
      kind: kindForEndpoints(endpoints),
      endpoints,
      providerData: { rawModels: variants } satisfies CopilotProviderData,
      ...(cost ? { cost } : {}),
      enabledFlags,
    });
  }
  return models;
};

export const createCopilotProvider = async (record: UpstreamRecord): Promise<ModelProviderInstance> => {
  const copilot = assertCopilotUpstreamRecord(record);
  const upstreamConfig = { id: copilot.id, githubToken: copilot.config.githubToken };
  // Computed once: only the upstream layer applies for this provider kind
  // (no per-model override layer).
  const upstreamFlags = resolveEffectiveFlags(defaultsForProvider('copilot'), [copilot.flagOverrides]);

  const call = async (
    transport: (config: typeof upstreamConfig, init: RequestInit, options: UpstreamFetchOptions) => Promise<Response>,
    body: Record<string, unknown>,
    signal: AbortSignal | undefined,
    rawModel: CopilotRawModel,
    headers: Headers,
    opts: UpstreamCallOptions,
  ): Promise<ProviderCallResult> => {
    const response = await transport(
      upstreamConfig,
      {
        method: 'POST',
        body: JSON.stringify({ ...body, model: rawModel.id }),
        signal,
      },
      { extraHeaders: headers, fetcher: opts.fetcher, recordUpstreamLatency: opts.recordUpstreamLatency },
    );
    return { response, modelKey: rawModel.id };
  };

  const callStreaming = <TEvent>(
    transport: (config: typeof upstreamConfig, init: RequestInit, options: UpstreamFetchOptions) => Promise<Response>,
    body: Record<string, unknown>,
    signal: AbortSignal | undefined,
    rawModel: CopilotRawModel,
    headers: Headers,
    parser: Parameters<typeof streamingProviderCall<TEvent>>[1],
    opts: UpstreamCallOptions,
  ) =>
    streamingProviderCall(
      transport(
        upstreamConfig,
        {
          method: 'POST',
          body: JSON.stringify({ ...body, stream: true, model: rawModel.id }),
          signal,
        },
        { extraHeaders: headers, fetcher: opts.fetcher, recordUpstreamLatency: opts.recordUpstreamLatency },
      ),
      parser,
      rawModel.id,
      signal,
    );

  // The boundary chain expects ExecuteResult shape so post-`run()` inspectors
  // (e.g. rewriteContextWindowError) can pattern-match on `result.type`. The
  // placeholder here only has to satisfy the EventResult contract while the
  // chain runs inside the provider boundary; real telemetry identity is
  // rebuilt downstream with pricing.
  const placeholderIdentity = (modelKey: string): TelemetryModelIdentity => ({
    model: modelKey,
    upstream: copilot.id,
    modelKey,
    cost: pricingForCopilotModelKey(modelKey),
  });

  // Materialize an upstream error body up-front so any interceptor that
  // inspects `result.body` (e.g. rewriteContextWindowError) sees the bytes.
  const liftStream = async <TEvent>(
    streamPromise: Promise<ProviderStreamResult<TEvent>>,
  ): Promise<ExecuteResult<ProtocolFrame<TEvent>>> => {
    const stream = await streamPromise;
    if (stream.ok) {
      return eventResult(
        stream.events as AsyncIterable<ProtocolFrame<TEvent>>,
        placeholderIdentity(stream.modelKey),
        { headers: stream.headers },
      );
    }
    return await readUpstreamApiError(stream.response);
  };

  // Lowering rebuilds a ProviderStreamResult so callers continue to relay
  // status/headers/body verbatim on errors and forward the typed event stream
  // on success. `internal-error` is not a shape any Copilot boundary
  // interceptor produces today; an explicit throw makes a future regression
  // noisy instead of silently dropping the result.
  const lowerToStream = <TEvent>(
    result: ExecuteResult<ProtocolFrame<TEvent>>,
    modelKey: string,
  ): ProviderStreamResult<TEvent> => {
    if (result.type === 'events') {
      return {
        ok: true,
        events: result.events as AsyncIterable<ProtocolFrame<TEvent>>,
        modelKey,
        ...(result.headers ? { headers: result.headers } : {}),
      };
    }
    if (result.type === 'api-error') {
      return { ok: false, response: apiErrorToResponse(result), modelKey };
    }
    throw new Error(`Copilot boundary chain produced unexpected ExecuteResult shape '${result.type}'`);
  };

  const provider: ModelProvider = {
    getProvidedModels: async fetcher => {
      const fresh = await getProviderRepo().upstreams.getById(copilot.id);
      if (!fresh) throw new Error(`Copilot upstream ${copilot.id} disappeared mid-request`);
      const initialState = readCopilotUpstreamState(fresh.state);
      const known = initialState.knownModels ?? emptyKnownModels();
      const response = await fetchCopilotModels(upstreamConfig, fetcher);
      const now = Date.now();
      const merged = mergeKnownModels(known, response, now);
      // Re-read after the upstream fetch — fetchCopilotModels may have minted a
      // new Copilot token via the auth path, which persists copilotToken under
      // its own CAS and advances state_json. Keying this save on the pre-fetch
      // snapshot would lose deterministically on every token mint (~each
      // expiry), so the known-models accumulator would never grow. Persistence
      // is best-effort either way: a losing CAS or thrown error must not
      // invalidate the response, which the caller is about to use.
      const latest = await getProviderRepo().upstreams.getById(copilot.id);
      if (latest) {
        const latestState = readCopilotUpstreamState(latest.state);
        try {
          await getProviderRepo().upstreams.saveState(
            copilot.id,
            { ...latestState, knownModels: merged } satisfies CopilotUpstreamState,
            { expectedState: latest.state },
          );
        } catch (err) {
          console.warn(`Failed to persist Copilot known-models for ${copilot.id}:`, err);
        }
      }
      return finalizeCopilotModels(projectKnownModels(merged, now), upstreamFlags);
    },
    getPricingForModelKey: pricingForCopilotModelKey,
    // Copilot's catalog never declares endpoints.completions, so this
    // stub is unreachable; the rejection surfaces a routing bug.
    callCompletions: rejectUnsupported('callCompletions'),
    callChatCompletions: async (model, body, signal, opts) => {
      const rawModel = rawModelFor(model, 'chatCompletions', { reasoningEffort: chatReasoningEffort(body) });
      const ctx: ChatCompletionsBoundaryCtx = {
        payload: { ...body, model: model.id },
        headers: new Headers(opts.headers),
        model,
      };
      const result = await runInterceptors<ChatCompletionsBoundaryCtx, object, ExecuteResult<ProtocolFrame<ChatCompletionsStreamEvent>>>(
        ctx, {}, COPILOT_CHATCOMPLETIONS_BOUNDARY, async () => {
          const { model: _ignored, ...wireBody } = ctx.payload;
          return await liftStream(callStreaming(copilotFetchChatCompletions, wireBody, signal, rawModel, ctx.headers, parseChatCompletionsStream, opts));
        },
      );
      return lowerToStream(result, rawModel.id);
    },
    callResponses: async (model, body, action, signal, opts) => {
      const rawModel = rawModelFor(model, 'responses', { reasoningEffort: responsesReasoningEffort(body) });
      const ctx: ResponsesBoundaryCtx = {
        payload: { ...body, model: model.id },
        headers: new Headers(opts.headers),
        model,
        action,
      };
      // Single chain wraps both branches; the terminal dispatches on
      // `ctx.action` (the post-chain value), so a mid-chain interceptor can
      // flip it and steer dispatch end-to-end. Copilot has no native
      // /v1/responses/compact, so the compact branch drives the same
      // /responses upstream with stream:false + a compaction_trigger input
      // item and reshapes the envelope via `compactionResponse`. Every
      // payload/header workaround in the chain — force-store-false,
      // strip-service-tier, strip-image-generation, inline-image
      // compression, vision/initiator headers — applies to both branches
      // identically; the two event-stream mutators
      // (`withOutputItemIdsSynchronized`, `withToolArgumentWhitespaceAborted`)
      // inspect the result variant and no-op on the compact value envelope.
      return await runInterceptors<ResponsesBoundaryCtx, object, ProviderResponsesResult>(
        ctx, {}, COPILOT_RESPONSES_BOUNDARY, async () => {
          const { model: _ignored, ...wireBody } = ctx.payload;
          switch (ctx.action) {
          case 'generate': {
            const stream = await callStreaming(copilotFetchResponses, wireBody, signal, rawModel, ctx.headers, parseResponsesStream, opts);
            return stream.ok
              ? { action: 'generate', ok: true, events: stream.events, modelKey: stream.modelKey, ...(stream.headers ? { headers: stream.headers } : {}) }
              : { action: 'generate', ok: false, response: stream.response, modelKey: stream.modelKey };
          }
          case 'compact': {
            const input: ResponsesInputItem[] = typeof wireBody.input === 'string' ? [{ type: 'message', role: 'user', content: wireBody.input }] : wireBody.input;
            const triggered = { ...wireBody, input: [...input, COMPACTION_TRIGGER], stream: false, model: rawModel.id };
            const response = await copilotFetchResponses(
              upstreamConfig,
              { method: 'POST', body: JSON.stringify(triggered), signal },
              { extraHeaders: ctx.headers, fetcher: opts.fetcher, recordUpstreamLatency: opts.recordUpstreamLatency },
            );
            if (!response.ok) return { action: 'compact', ok: false, response, modelKey: rawModel.id };
            const generated = (await response.json()) as ResponsesResult;
            return { action: 'compact', ok: true, result: compactionResponse(input, generated), modelKey: rawModel.id };
          }
          default:
            ctx.action satisfies never;
            throw new Error(`Unhandled ResponsesAction: ${ctx.action as string}`);
          }
        },
      );
    },
    callMessages: async (model, body, signal, opts) => {
      // Fast Mode is a hard contract on the request side: Anthropic returns
      // HTTP 400 invalid_request_error when a model does not support it, with
      // no silent fallback to standard speed. We mirror that at the gateway
      // boundary before any per-Copilot workaround runs — selection alone is
      // best-effort, so the pre-check here is what makes Fast Mode honest.
      // https://docs.claude.com/en/build-with-claude/fast-mode
      //
      // The `error.message` is byte-identical to the string Anthropic emits
      // on the real wire, recorded verbatim from a live response by an
      // independent gateway's regression test:
      // https://github.com/Yeachan-Heo/gajae-code/blob/main/packages/ai/test/anthropic-fast-mode.test.ts
      if (body.speed === 'fast') {
        const providerData = model.providerData as CopilotProviderData;
        if (!copilotModelSupportsFastMode(providerData.rawModels)) {
          return {
            ok: false,
            response: Response.json(
              {
                type: 'error',
                error: {
                  type: 'invalid_request_error',
                  message: `'${model.id}' does not support the \`speed\` parameter.`,
                },
              },
              { status: 400 },
            ),
            modelKey: model.id,
          };
        }
      }

      // Both the native Messages call and count_tokens select the same raw
      // `messages` variant; they differ only in the upstream endpoint path.
      // Variant selection runs BEFORE the boundary chain's allow-list filter
      // mutates `anthropic-beta` on the wire, so we read the caller's
      // untouched intent here.
      const betas = parseAnthropicBetaHeader(opts.headers.get('anthropic-beta'));
      const rawModel = rawModelFor(model, 'messages', {
        context1m: betas.includes(CONTEXT_1M_BETA),
        reasoningEffort: messagesReasoningEffort(body),
        fast: body.speed === 'fast',
      });
      const ctx: MessagesBoundaryCtx = {
        payload: { ...body, model: model.id },
        headers: new Headers(opts.headers),
        model,
      };
      const result = await runInterceptors<MessagesBoundaryCtx, object, ExecuteResult<ProtocolFrame<MessagesStreamEvent>>>(
        ctx, {}, COPILOT_MESSAGES_BOUNDARY, async () => {
          const { model: _ignored, ...wireBody } = ctx.payload;
          return await liftStream(callStreaming(copilotFetchMessages, wireBody, signal, rawModel, ctx.headers, parseMessagesStream, opts));
        },
      );
      return lowerToStream(result, rawModel.id);
    },
    callMessagesCountTokens: async (model, body, signal, opts) => {
      const betas = parseAnthropicBetaHeader(opts.headers.get('anthropic-beta'));
      const rawModel = rawModelFor(model, 'messages', {
        context1m: betas.includes(CONTEXT_1M_BETA),
        reasoningEffort: messagesReasoningEffort(body),
      });
      const ctx: MessagesCountTokensBoundaryCtx = {
        payload: { ...body, model: model.id },
        headers: new Headers(opts.headers),
        model,
      };
      const response = await runInterceptors<MessagesCountTokensBoundaryCtx, object, Response>(
        ctx, {}, COPILOT_MESSAGES_COUNT_TOKENS_BOUNDARY, async () => {
          const { model: _ignored, ...wireBody } = ctx.payload;
          const { response } = await call(copilotFetchMessagesCountTokens, wireBody, signal, rawModel, ctx.headers, opts);
          return response;
        },
      );
      return { response, modelKey: rawModel.id };
    },
    callEmbeddings: (model, body, signal, opts) => call(copilotFetchEmbeddings, copilotEmbeddingsBody(body), signal, rawModelFor(model, 'embeddings'), opts.headers, opts),
    // Copilot has no /images/* upstream; catalog never emits a kind='image'
    // model, so these stubs are unreachable.
    callImagesGenerations: rejectUnsupported('callImagesGenerations'),
    callImagesEdits: rejectUnsupported('callImagesEdits'),
  };

  return {
    upstream: copilot.id,
    providerKind: 'copilot',
    name: copilot.name,
    disabledPublicModelIds: copilot.disabledPublicModelIds,
    modelPrefix: copilot.modelPrefix,
    provider,
    supportsResponsesItemReference: false,
  };
};
