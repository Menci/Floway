import { projectCopilotModels, rawModelSupportsEndpoint } from './catalog.ts';
import { COMPACTION_TRIGGER, compactionResponse } from './compaction.ts';
import { assertCopilotUpstreamRecord } from './config.ts';
import { fetchCopilotModels } from './fetch-models.ts';
import { copilotFetchOpenAIChatCompletions, copilotFetchOpenAIEmbeddings, copilotFetchAnthropicMessages, copilotFetchAnthropicMessagesCountTokens, copilotFetchOpenAIImagesEdits, copilotFetchOpenAIImagesGenerations, copilotFetchOpenAIResponses, copilotFetchDecision, type CopilotDataPlaneFetchOptions } from './fetch.ts';
import { COPILOT_ANTHROPIC_MESSAGES_BOUNDARY, COPILOT_ANTHROPIC_MESSAGES_COUNT_TOKENS_BOUNDARY } from './interceptors/anthropic-messages/index.ts';
import type { AnthropicMessagesBoundaryCtx } from './interceptors/anthropic-messages/types.ts';
import { COPILOT_OPENAI_CHAT_COMPLETIONS_BOUNDARY } from './interceptors/openai-chat-completions/index.ts';
import type { OpenAIChatCompletionsBoundaryCtx } from './interceptors/openai-chat-completions/types.ts';
import { COPILOT_OPENAI_RESPONSES_BOUNDARY } from './interceptors/openai-responses/index.ts';
import type { OpenAIResponsesBoundaryCtx } from './interceptors/openai-responses/types.ts';
import { emptyKnownModels, mergeKnownModels, projectKnownModels } from './known-models.ts';
import { CONTEXT_1M_BETA, copilotModelSupportsFastVariant, type ModelSelectionHints, resolveCopilotRawModel } from './model-selection.ts';
import { copilotVariantIndex } from './model-variants.ts';
import { runCopilotScheduledTask } from './scheduled.ts';
import { readCopilotUpstreamState, type CopilotUpstreamState } from './state.ts';
import type { CopilotRawModel } from './types.ts';
import { runInterceptors } from '@floway-dev/interceptor';
import { parseAnthropicMessagesStream, type AnthropicMessagesPayload, type AnthropicMessagesStreamEventEx } from '@floway-dev/protocols/anthropic-messages';
import { type ModelEndpointKey, type ProtocolFrame, isFastServiceTier } from '@floway-dev/protocols/common';
import { DEFAULT_DECISION_PATHS, serializeDecisionRequest, type CanonicalDecisionRequest } from '@floway-dev/protocols/decision';
import { parseOpenAIChatCompletionsStream, type OpenAIChatCompletionsPayloadEx, type OpenAIChatCompletionsStreamEvent } from '@floway-dev/protocols/openai-chat-completions';
import { parseOpenAIResponsesStream, type CanonicalOpenAIResponsesPayload, type OpenAIResponsesResultEx } from '@floway-dev/protocols/openai-responses';
import { eventResult, getProviderRepo, headersForAnthropicMessagesCall, jsonRequestBody, serializeOpenAIImagesEditsRequest, readUpstreamApiError, streamingProviderCall, bufferedResultToResponse, type ExecuteResult, type FetchInit, type HttpHeaderLines, type ProviderInstance, type Provider, type ProviderCallResult, type ProviderModel, type ProviderOpenAIResponsesResult, type ProviderStreamResult, type TelemetryModelIdentity, type UpstreamCallOptions, type UpstreamRecord } from '@floway-dev/provider';

interface CopilotProviderData {
  rawModels: CopilotRawModel[];
}

const chatReasoningEffort = (body: Omit<OpenAIChatCompletionsPayloadEx, 'model'>): string | undefined => (body.reasoning_effort && body.reasoning_effort !== 'none' ? body.reasoning_effort : undefined);

const anthropicMessagesReasoningEffort = (body: Omit<AnthropicMessagesPayload, 'model'>): string | undefined => body.output_config?.effort ?? undefined;

const openaiResponsesReasoningEffort = (body: Omit<CanonicalOpenAIResponsesPayload, 'model'>): string | undefined => (body.reasoning?.effort && body.reasoning.effort !== 'none' ? body.reasoning.effort : undefined);

const anthropicMessagesBoundaryContext = (
  body: Omit<AnthropicMessagesPayload, 'model'>,
  model: ProviderModel,
  headers: Headers,
  anthropicBeta: readonly string[],
): AnthropicMessagesBoundaryCtx => {
  return {
    payload: { ...body, model: model.id },
    headers: new Headers(headers),
    anthropicBeta: [...anthropicBeta],
    model,
  };
};

const rejectUnsupported = (capability: string) => (): Promise<never> =>
  Promise.reject(new Error(`Copilot provider does not implement ${capability}`));

const rawModelFor = (model: ProviderModel, endpoint: ModelEndpointKey, hints: ModelSelectionHints = {}): CopilotRawModel => {
  // Copilot exposes one canonical public Claude model id per family. Raw
  // variant selection is derived from request body fields and parsed Anthropic Messages
  // beta intent, not from the client's original model alias string.
  const rawModels = (model.providerData as CopilotProviderData).rawModels.filter(rawModel => rawModelSupportsEndpoint(rawModel, endpoint));
  if (rawModels.length === 0) {
    throw new Error(`Copilot provider exposed ${endpoint} for ${model.id}, but no raw variant supports that endpoint`);
  }
  return resolveCopilotRawModel({ object: 'list', data: rawModels }, model.id, hints) ?? rawModels[0];
};

const copilotOpenAIEmbeddingsBody = (body: Record<string, unknown>): Record<string, unknown> => {
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

export const createCopilotProvider = (record: UpstreamRecord): Provider => {
  const copilot = assertCopilotUpstreamRecord(record);
  const upstreamConfig = { id: copilot.id, githubHost: copilot.config.githubHost, githubToken: copilot.config.githubToken };

  const call = async (
    transport: (config: typeof upstreamConfig, init: FetchInit, options: CopilotDataPlaneFetchOptions) => Promise<Response>,
    body: Record<string, unknown>,
    signal: AbortSignal | undefined,
    rawModel: CopilotRawModel,
    headers: HttpHeaderLines,
    opts: UpstreamCallOptions,
  ): Promise<ProviderCallResult> => {
    const response = await transport(
      upstreamConfig,
      {
        method: 'POST',
        body: jsonRequestBody({ ...body, model: rawModel.id }),
        signal,
      },
      { extraHeaders: headers, fetcher: opts.fetcher, wrapUpstreamCall: opts.wrapUpstreamCall, waitUntil: opts.waitUntil },
    );
    return { http: response, modelKey: rawModel.id };
  };

  const callStreaming = <TEvent>(
    transport: (config: typeof upstreamConfig, init: FetchInit, options: CopilotDataPlaneFetchOptions) => Promise<Response>,
    body: Record<string, unknown>,
    signal: AbortSignal | undefined,
    rawModel: CopilotRawModel,
    headers: HttpHeaderLines,
    parser: Parameters<typeof streamingProviderCall<TEvent>>[1],
    opts: UpstreamCallOptions,
  ) =>
    streamingProviderCall(
      transport(
        upstreamConfig,
        {
          method: 'POST',
          body: jsonRequestBody({ ...body, stream: true, model: rawModel.id }),
          signal,
        },
        { extraHeaders: headers, fetcher: opts.fetcher, wrapUpstreamCall: opts.wrapUpstreamCall, waitUntil: opts.waitUntil },
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
    pricing: null,
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
        { http: stream.http },
      );
    }
    return await readUpstreamApiError(stream.http);
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
        ...(result.http === undefined ? {} : { http: result.http }),
      };
    }
    if (result.type === 'api-error') {
      return { ok: false, http: bufferedResultToResponse(result), modelKey };
    }
    throw new Error(`Copilot boundary chain produced unexpected ExecuteResult shape '${result.type}'`);
  };

  const instance: ProviderInstance = {
    runScheduledTask: options => runCopilotScheduledTask(record, options),
    callAlphaSearch: rejectUnsupported('callAlphaSearch'),
    callGeminiGenerateContent: rejectUnsupported('callGeminiGenerateContent'),
    callGeminiGenerateContentCountTokens: rejectUnsupported('callGeminiGenerateContentCountTokens'),
    getProvidedModels: async fetcher => {
      const fresh = await getProviderRepo().upstreams.getById(copilot.id);
      if (!fresh) throw new Error(`Copilot upstream ${copilot.id} disappeared mid-request`);
      const known = readCopilotUpstreamState(fresh.state).knownModels ?? emptyKnownModels();
      const response = await fetchCopilotModels(upstreamConfig, fetcher);
      const now = Date.now();
      const merged = mergeKnownModels(known, response, now);
      // The accumulator merges into whatever is stored at write time, not into
      // the snapshot read before the fetch — fetchCopilotModels may have minted
      // a token and written this same row on the way through. Persistence stays
      // best-effort: the fetched catalog is what the caller is about to serve,
      // and a storage failure only costs the next call the entries this one
      // would have added.
      try {
        await getProviderRepo().upstreams.saveState(copilot.id, current => {
          const state = readCopilotUpstreamState(current);
          return {
            ...state,
            knownModels: mergeKnownModels(state.knownModels ?? emptyKnownModels(), response, now),
          } satisfies CopilotUpstreamState;
        });
      } catch (err) {
        console.warn(`Failed to persist Copilot known-models for ${copilot.id}:`, err);
      }
      const rawModels = projectKnownModels(merged, now);
      const { families } = copilotVariantIndex(rawModels);
      return projectCopilotModels(rawModels, copilot.flagOverrides).map(model => ({
        ...model,
        providerData: { rawModels: families.get(model.id)! } satisfies CopilotProviderData,
      }));
    },
    // Copilot's catalog never declares endpoints.openaiCompletions, so this
    // stub is unreachable; the rejection surfaces a routing bug.
    callOpenAICompletions: rejectUnsupported('callOpenAICompletions'),
    callOpenAIChatCompletions: async (model, body, signal, opts) => {
      // No accelerated-lane hint here on purpose. Copilot's /chat/completions
      // accepts `service_tier` only to ignore it, answering
      // `service_tier: "default"` even on a request that carried `priority`.
      // Selecting a `-fast` raw variant from this entry point would have
      // GitHub charge us the fast rates while the response reports the base
      // tier, which is the one combination our billing cannot see through.
      const rawModel = rawModelFor(model, 'openaiChatCompletions', { reasoningEffort: chatReasoningEffort(body) });
      const ctx: OpenAIChatCompletionsBoundaryCtx = {
        payload: { ...body, model: model.id },
        headers: new Headers(opts.headers),
        model,
      };
      const result = await runInterceptors<OpenAIChatCompletionsBoundaryCtx, object, ExecuteResult<ProtocolFrame<OpenAIChatCompletionsStreamEvent>>>(
        ctx, {}, COPILOT_OPENAI_CHAT_COMPLETIONS_BOUNDARY, async () => {
          const { model: _ignored, ...wireBody } = ctx.payload;
          return await liftStream(callStreaming(copilotFetchOpenAIChatCompletions, wireBody, signal, rawModel, [...ctx.headers], parseOpenAIChatCompletionsStream, opts));
        },
      );
      return lowerToStream(result, rawModel.id);
    },
    callOpenAIResponses: async (model, body, action, signal, opts) => {
      // `service_tier` naming the accelerated lane — `priority`, or its
      // post-rename synonym `fast` — picks the family's `-fast` raw variant.
      // Copilot rejects the field itself with HTTP 400 `unsupported_value`
      // (see `strip-service-tier.ts`), so the raw id is the only way to reach
      // the lane. Unlike Anthropic Messages below there is no hard pre-check:
      // OpenAI declines an unavailable Fast mode silently and reports the tier
      // it actually served, and Copilot does the same, so a family without a
      // `-fast` variant falls back to its base and answers
      // `service_tier: "default"`. The caller is told which tier ran and
      // `billableUsageFromOpenAIResponsesResult` prices that one.
      // https://github.com/openai/codex/issues/32191
      // https://learn.microsoft.com/en-sg/answers/questions/5921564/we-send-service-tier-priority-on-a-gpt-4-1-mini-gl
      const rawModel = rawModelFor(model, 'openaiResponses', {
        reasoningEffort: openaiResponsesReasoningEffort(body),
        fast: isFastServiceTier(body.service_tier),
      });
      const ctx: OpenAIResponsesBoundaryCtx = {
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
      // payload/header workaround in the chain — strip-service-tier,
      // strip-image-generation, inline-image compression, vision/initiator
      // headers — applies to both branches identically. The item-id membrane
      // also normalizes the compact value envelope, while the whitespace
      // guard only inspects generate streams.
      return await runInterceptors<OpenAIResponsesBoundaryCtx, object, ProviderOpenAIResponsesResult>(
        ctx, {}, COPILOT_OPENAI_RESPONSES_BOUNDARY, async () => {
          const { model: _ignored, ...wireBody } = ctx.payload;
          switch (ctx.action) {
          case 'generate': {
            const stream = await callStreaming(copilotFetchOpenAIResponses, wireBody, signal, rawModel, [...ctx.headers], parseOpenAIResponsesStream, opts);
            return { action: 'generate', ...stream };
          }
          case 'compact': {
            const input = wireBody.input;
            const triggered = { ...wireBody, input: [...input, COMPACTION_TRIGGER], stream: false, model: rawModel.id };
            const response = await copilotFetchOpenAIResponses(
              upstreamConfig,
              { method: 'POST', body: jsonRequestBody(triggered), signal },
              { extraHeaders: [...ctx.headers], fetcher: opts.fetcher, wrapUpstreamCall: opts.wrapUpstreamCall, waitUntil: opts.waitUntil },
            );
            if (!response.ok) return { action: 'compact', ok: false, http: response, modelKey: rawModel.id };
            const generated = (await response.json()) as OpenAIResponsesResultEx;
            return { action: 'compact', ok: true, result: compactionResponse(input, generated), modelKey: rawModel.id, http: { status: response.status, headers: response.headers } };
          }
          default:
            ctx.action satisfies never;
            throw new Error(`Unhandled OpenAIResponsesAction: ${ctx.action as string}`);
          }
        },
      );
    },
    callAnthropicMessages: async (model, body, signal, opts) => {
      // Fast Mode is a hard contract on the request side: Anthropic returns
      // HTTP 400 invalid_request_error when a model does not support it, with
      // no silent fallback to standard speed. We mirror that at the gateway
      // boundary before any per-Copilot workaround runs — selection alone is
      // best-effort, and Copilot never echoes `usage.speed`, so an unchecked
      // downgrade would be invisible to the caller and to billing alike. The
      // OpenAI spelling of the same lane takes the opposite path in
      // `callOpenAIResponses`, where the upstream reports the tier it served.
      // https://docs.claude.com/en/build-with-claude/fast-mode
      //
      // The `error.message` is byte-identical to the string Anthropic emits
      // on the real wire, recorded verbatim from a live response by an
      // independent gateway's regression test:
      // https://github.com/Yeachan-Heo/gajae-code/blob/main/packages/ai/test/anthropic-fast-mode.test.ts
      if (body.speed === 'fast') {
        const providerData = model.providerData as CopilotProviderData;
        if (!copilotModelSupportsFastVariant(providerData.rawModels)) {
          return {
            ok: false,
            http: Response.json(
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

      // Both the native Anthropic Messages call and count_tokens select the same raw
      // `messages` variant; they differ only in the upstream endpoint path.
      const ctx = anthropicMessagesBoundaryContext(body, model, opts.headers, opts.anthropicBeta);
      const rawModel = rawModelFor(model, 'anthropicMessages', {
        context1m: ctx.anthropicBeta.includes(CONTEXT_1M_BETA),
        reasoningEffort: anthropicMessagesReasoningEffort(body),
        fast: body.speed === 'fast',
      });
      const result = await runInterceptors<AnthropicMessagesBoundaryCtx, object, ExecuteResult<ProtocolFrame<AnthropicMessagesStreamEventEx>>>(
        ctx, {}, COPILOT_ANTHROPIC_MESSAGES_BOUNDARY, async () => {
          const { model: _ignored, ...wireBody } = ctx.payload;
          return await liftStream(callStreaming(copilotFetchAnthropicMessages, wireBody, signal, rawModel, headersForAnthropicMessagesCall([...ctx.headers], ctx.anthropicBeta), parseAnthropicMessagesStream, opts));
        },
      );
      return lowerToStream(result, rawModel.id);
    },
    callAnthropicMessagesCountTokens: async (model, body, signal, opts) => {
      const ctx = anthropicMessagesBoundaryContext(body, model, opts.headers, opts.anthropicBeta);
      const rawModel = rawModelFor(model, 'anthropicMessages', {
        context1m: ctx.anthropicBeta.includes(CONTEXT_1M_BETA),
        reasoningEffort: anthropicMessagesReasoningEffort(body),
      });
      const response = await runInterceptors<AnthropicMessagesBoundaryCtx, object, Response>(
        ctx, {}, COPILOT_ANTHROPIC_MESSAGES_COUNT_TOKENS_BOUNDARY, async () => {
          const { model: _ignored, ...wireBody } = ctx.payload;
          const { http: response } = await call(copilotFetchAnthropicMessagesCountTokens, wireBody, signal, rawModel, headersForAnthropicMessagesCall([...ctx.headers], ctx.anthropicBeta), opts);
          return response;
        },
      );
      return { http: response, modelKey: rawModel.id };
    },
    callOpenAIEmbeddings: (model, body, signal, opts) => call(copilotFetchOpenAIEmbeddings, copilotOpenAIEmbeddingsBody(body), signal, rawModelFor(model, 'openaiEmbeddings'), [...opts.headers], opts),
    callOpenAIImagesGenerations: (model, body, signal, opts) =>
      call(copilotFetchOpenAIImagesGenerations, body, signal, rawModelFor(model, 'openaiImagesGenerations'), [...opts.headers], opts),
    callOpenAIImagesEdits: async (model, request, signal, opts) => {
      const rawModel = rawModelFor(model, 'openaiImagesEdits');
      // `serializeOpenAIImagesEditsRequest` yields multipart when every source
      // is an upload or an inlined data URL, and JSON references otherwise.
      // Copilot accepts both encodings. A `reference` source carrying a remote
      // URL is the one shape it refuses with
      // `400 external image URLs are not supported`; that response is relayed
      // to the caller unchanged rather than pre-empted here.
      const body = await serializeOpenAIImagesEditsRequest(request, rawModel.id);
      const response = await copilotFetchOpenAIImagesEdits(
        upstreamConfig,
        { method: 'POST', body, signal },
        { extraHeaders: [...opts.headers], fetcher: opts.fetcher, wrapUpstreamCall: opts.wrapUpstreamCall, waitUntil: opts.waitUntil },
      );
      return { http: response, modelKey: rawModel.id };
    },
    callOpenAIAudioTranscriptions: rejectUnsupported('callOpenAIAudioTranscriptions'),
    callRerank: rejectUnsupported('callRerank'),
    callDecision: async (model: ProviderModel, request: CanonicalDecisionRequest, signal: AbortSignal | undefined, opts: UpstreamCallOptions) => {
      const target = model.decisionTarget;
      if (target === undefined) throw new Error(`Decision model ${model.id} has no outbound target`);
      const rawModel = rawModelFor(model, 'decision');
      const body = serializeDecisionRequest(target.protocol, rawModel.id, request);
      const response = await copilotFetchDecision(
        upstreamConfig,
        target.path ?? DEFAULT_DECISION_PATHS[target.protocol],
        { method: 'POST', body: jsonRequestBody(body), signal },
        { extraHeaders: [...opts.headers], fetcher: opts.fetcher, wrapUpstreamCall: opts.wrapUpstreamCall },
      );
      return { http: response, modelKey: rawModel.id, target };
    },
  };

  return {
    upstreamId: copilot.id,
    kind: 'copilot',
    name: copilot.name,
    inboundHeaderAllowlist: [],
    disabledPublicModelIds: copilot.disabledPublicModelIds,
    modelPrefix: copilot.modelPrefix,
    modelsCache: copilot.modelsCache,
    instance,
  };
};
