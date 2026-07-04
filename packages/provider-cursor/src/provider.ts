import { ensureCursorAccessToken, mintCursorAccessToken } from './access-token-cache.ts';
import { CursorSessionTerminatedError } from './auth/oauth.ts';
import { generateCursorChecksum } from './checksum.ts';
import { applyStops, completionsResponseBody, type CompletionsUsage, estimateCursorTabTokens, extractInsertion, languageIdForCompletion, parsePrefixSuffix, streamCppInputForPrefixSuffix } from './completions.ts';
import { assertCursorUpstreamRecord, type CursorUpstreamConfig } from './config.ts';
import { readObservedContext } from './context-window.ts';
import { callCursorChatCompletions, syntheticErrorResponse, type CursorCallEffects } from './fetch.ts';
import { cursorChatCompletionsChain } from './interceptors/chat-completions/index.ts';
import type { ChatCompletionsBoundaryCtx } from './interceptors/chat-completions/types.ts';
import { cursorRawToProviderModel, cursorTabModel, fetchCursorCatalog, resolveCursorWireModel } from './models.ts';
import { pricingForCursorModelKey } from './pricing.ts';
import type { StreamCppRequestInput } from './proto/stream-cpp.ts';
import { assertCursorUpstreamState, type CursorUpstreamState } from './state.ts';
import { callStreamCpp } from './stream-cpp-transport.ts';
import { detectPromptFormat, parseZetaV0318, renderZetaV0318Output, streamCppInputForZeta } from './zeta-format.ts';
import { parseZetaV0615, renderV0615Output, streamCppInputForV0615 } from './zeta-v0615.ts';
import { runInterceptors } from '@floway-dev/interceptor';
import type { ChatCompletionsStreamEvent } from '@floway-dev/protocols/chat-completions';
import {
  defaultsForProvider,
  getProviderRepo,
  resolveEffectiveFlags,
  type Provider,
  type ProviderCallResult,
  type ProviderInstance,
  type ProviderResponsesResult,
  type ProviderStreamResult,
  type ResponsesAction,
  type UpstreamCallOptions,
  type UpstreamRecord,
} from '@floway-dev/provider';

const gatewayTimezone = (): string => Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC';

export const createCursorProvider = async (record: UpstreamRecord): Promise<Provider> => {
  assertCursorUpstreamRecord(record);
  assertCursorUpstreamState(record.state);
  const config: CursorUpstreamConfig = record.config;
  // Always operates on the first account in the pool. The schema carries an
  // array so a future fan-out can pick a different active account per call
  // without a wire migration.
  const accountIdentity = config.accounts[0];

  const enabledFlags = resolveEffectiveFlags(defaultsForProvider('cursor'), [record.flagOverrides]);

  // Re-read upstream state on every request rather than capturing the record's
  // state at construction. Refresh-token rotation, terminal-state transitions,
  // and operator re-imports must all be visible to the next in-flight call.
  const readActiveAccount = async () => {
    const fresh = await getProviderRepo().upstreams.getById(record.id);
    if (!fresh) throw new Error(`Cursor upstream ${record.id} disappeared mid-request`);
    assertCursorUpstreamState(fresh.state);
    const state = fresh.state;
    const account = state.accounts.find(a => a.userId === accountIdentity.userId);
    if (!account) {
      throw new Error(`Cursor upstream ${record.id} state has no credential for account ${accountIdentity.userId}`);
    }
    return { state, account };
  };

  const replaceActiveAccount = (
    state: CursorUpstreamState,
    next: CursorUpstreamState['accounts'][number],
  ): CursorUpstreamState => ({
    ...state,
    accounts: state.accounts.map(a => (a.userId === next.userId ? next : a)),
  });

  const persistRefreshTokenRotation = async (newRefreshToken: string): Promise<void> => {
    const { state, account } = await readActiveAccount();
    const next = replaceActiveAccount(state, {
      ...account,
      refresh_token: newRefreshToken,
      state_updated_at: new Date().toISOString(),
    });
    await getProviderRepo().upstreams.saveState(record.id, next, { expectedState: state });
  };

  const persistTerminalState = async (
    newState: 'session_terminated' | 'refresh_failed',
    message: string,
  ): Promise<void> => {
    const { state, account } = await readActiveAccount();
    const next = replaceActiveAccount(state, {
      ...account,
      state: newState,
      state_message: message,
      state_updated_at: new Date().toISOString(),
      accessToken: null,
    });
    await getProviderRepo().upstreams.saveState(record.id, next, { expectedState: state });
  };

  const effects: CursorCallEffects = { persistRefreshTokenRotation, persistTerminalState };

  const provider: ProviderInstance = {
    getProvidedModels: async fetcher => {
      // A model-list refresh is the first thing a brand-new Cursor upstream
      // does, and it mints an access token. If the refresh_token has been
      // revoked, flip the row to refresh_failed and rethrow.
      let access;
      try {
        access = await ensureCursorAccessToken(record.id, accountIdentity.userId, refresh =>
          mintCursorAccessToken(refresh, fetcher, persistRefreshTokenRotation));
      } catch (err) {
        if (err instanceof CursorSessionTerminatedError) {
          await persistTerminalState('refresh_failed', err.upstreamMessage);
        }
        throw err;
      }
      const raw = await fetchCursorCatalog({ accessToken: access.token, timezone: gatewayTimezone(), fetcher, maxMode: config.maxMode });
      // Fresh state carries the per-model context windows observed on prior
      // RunSSE turns; a read failure just falls back to the tooltip heuristic.
      let observedState: CursorUpstreamState | null = null;
      try { observedState = (await readActiveAccount()).state; } catch { observedState = null; }
      const observedAt = Date.now();
      const maxMode = config.maxMode ?? false;
      const models = raw.map(r => {
        const model = cursorRawToProviderModel(r, enabledFlags);
        // Prefer a real context window observed on the RunSSE stream
        // (ConversationTokenDetails.maxTokens) over the tooltip-derived
        // heuristic — it's the authoritative number for the active mode.
        const observed = observedState ? readObservedContext(observedState, model.id, maxMode, observedAt) : null;
        if (observed) model.limits = { ...model.limits, max_context_window_tokens: observed };
        return model;
      });
      // Cursor Tab (StreamCpp) is exposed as an extra /v1/completions model.
      if (config.tabCompletion?.enabled) models.push(cursorTabModel(enabledFlags));
      return models;
    },

    // Cursor bills as a flat-fee subscription; the dashboard reports notional
    // cost per request as if paying the underlying model's public API rates.
    getPricingForModelKey: pricingForCursorModelKey,

    callChatCompletions: async (model, body, signal, opts) => {
      // Resolve the wire variant from the request's reasoning_effort before the
      // interceptor chain strips it from the payload.
      const wireModelId = resolveCursorWireModel(model, body.reasoning_effort);
      const ctx: ChatCompletionsBoundaryCtx = {
        payload: { ...body, model: model.id },
        headers: new Headers(opts.headers),
        model,
      };
      return await runInterceptors<ChatCompletionsBoundaryCtx, object, ProviderStreamResult<ChatCompletionsStreamEvent>>(
        ctx,
        {},
        cursorChatCompletionsChain<ProviderStreamResult<ChatCompletionsStreamEvent>>(),
        async () => {
          const { account } = await readActiveAccount();
          const { model: _ignored, ...wireBody } = ctx.payload;
          return await callCursorChatCompletions({
            upstreamId: record.id,
            account,
            model,
            body: wireBody,
            headers: ctx.headers,
            signal,
            effects,
            call: opts,
            maxMode: config.maxMode ?? false,
            wireModelId,
            // Absent config value = privacy on (safe default). Only the chat
            // data plane honors this; model-catalog fetch stays always-private.
            privacyMode: config.privacyMode ?? true,
          });
        },
      );
    },

    // Cursor upstream only exposes Chat Completions (RunSSE+BidiAppend);
    // getProvidedModels advertises that single endpoint. Every other surface
    // returns a 405 carrying a proper JSON error rather than a raw stack trace.
    // The synthetic response still flows through the per-call latency recorder
    // so the gateway's wrap-once contract holds.
    callMessages: (_m, _b, _s, opts) => unsupportedStreamResult(opts),
    callResponses: (_m, _b, action, _s, opts) => unsupportedResponsesResult(action, opts),
    callMessagesCountTokens: (_m, _b, _s, opts) => unsupportedCallResult(opts),
    // Cursor Tab (StreamCpp) bridged to OpenAI /v1/completions. A completion is
    // never allowed to hard-fail an editor, so any error / non-clean edit
    // yields an empty suggestion rather than a 5xx.
    callCompletions: async (model, body, signal, opts) => {
      if (!config.tabCompletion?.enabled) return await unsupportedCallResult(opts);
      const zeroUsage: CompletionsUsage = { promptTokens: 0, completionTokens: 0 };
      const emptyResponse = () => new Response(completionsResponseBody(model.id, '', zeroUsage), { status: 200, headers: { 'content-type': 'application/json' } });
      // Static token estimator — StreamCpp returns no usage of its own, so we
      // derive prompt tokens from the file we sent Cursor and completion
      // tokens from the raw upstream text (pre-render). See
      // `estimateCursorTabTokens` in completions.ts for the ratio calibration.
      const usageOf = (request: StreamCppRequestInput, outputText: string): CompletionsUsage => ({
        promptTokens: estimateCursorTabTokens(request.contents, request.languageId),
        completionTokens: estimateCursorTabTokens(outputText, request.languageId),
      });
      const modelName = config.tabCompletion?.model ?? 'fast';
      const call = (async (): Promise<Response> => {
        try {
          const prompt = typeof body.prompt === 'string' ? body.prompt : '';
          const format = detectPromptFormat(prompt);
          const withToken = async () => {
            const access = await ensureCursorAccessToken(record.id, accountIdentity.userId, refresh => mintCursorAccessToken(refresh, opts.fetcher, persistRefreshTokenRotation));
            return { access, checksum: await generateCursorChecksum(access.token) };
          };

          // Zeta 2.1 (V0318) marker path: reconstruct the editable region from
          // the prompt, ask Cursor Tab to rewrite the file, and re-emit the
          // rewritten region as a `<|marker_1|>…<|marker_K|>` span. Falls back
          // to the FIM/plain insertion path for any unparseable prompt.
          const parsed = format === 'zeta-v0318' ? parseZetaV0318(prompt) : null;
          if (parsed) {
            const { access, checksum } = await withToken();
            const request = streamCppInputForZeta(parsed, modelName);
            const result = await callStreamCpp({ fetcher: opts.fetcher, accessToken: access.token, checksum, request, signal });
            const rendered = result.ok ? renderZetaV0318Output(parsed, result.rangeToReplace, result.text) : null;
            return new Response(completionsResponseBody(model.id, rendered ?? '', usageOf(request, result.ok ? result.text : '')), { status: 200, headers: { 'content-type': 'application/json' } });
          }

          // Zeta V0615 hashed-regions path (custom clients only — not a Zed GUI
          // option). Same shape as V0318 but the region is one file excerpt.
          const parsed615 = format === 'zeta-v0615' ? parseZetaV0615(prompt) : null;
          if (parsed615) {
            const { access, checksum } = await withToken();
            const request = streamCppInputForV0615(parsed615, modelName);
            const result = await callStreamCpp({ fetcher: opts.fetcher, accessToken: access.token, checksum, request, signal });
            const rendered = result.ok ? renderV0615Output(parsed615, result.rangeToReplace, result.text) : null;
            return new Response(completionsResponseBody(model.id, rendered ?? '', usageOf(request, result.ok ? result.text : '')), { status: 200, headers: { 'content-type': 'application/json' } });
          }

          // FIM / plain-prompt insertion path.
          const ps = parsePrefixSuffix(prompt, typeof body.suffix === 'string' ? body.suffix : undefined);
          const request = streamCppInputForPrefixSuffix(ps, { relativePath: 'completion.txt', languageId: languageIdForCompletion(body), modelName });
          const { access, checksum } = await withToken();
          const result = await callStreamCpp({ fetcher: opts.fetcher, accessToken: access.token, checksum, request, signal });
          const insertion = result.ok ? applyStops(extractInsertion(ps, result.rangeToReplace, result.text), body.stop as string | string[] | undefined) : '';
          return new Response(completionsResponseBody(model.id, insertion, usageOf(request, result.ok ? result.text : '')), { status: 200, headers: { 'content-type': 'application/json' } });
        } catch {
          return emptyResponse();
        }
      })();
      return { response: await opts.recordUpstreamLatency(call), modelKey: model.id };
    },
    callEmbeddings: (_m, _b, _s, opts) => unsupportedCallResult(opts),
    callImagesGenerations: (_m, _b, _s, opts) => unsupportedCallResult(opts),
    callImagesEdits: (_m, _b, _s, opts) => unsupportedCallResult(opts),
  };

  return {
    upstream: record.id,
    kind: 'cursor',
    name: record.name,
    disabledPublicModelIds: record.disabledPublicModelIds,
    modelPrefix: record.modelPrefix,
    instance: provider,
    supportsResponsesItemReference: false,
  };
};

const syntheticUnsupportedResponse = (): Response =>
  syntheticErrorResponse(405, 'method_not_allowed', 'Endpoint not supported by cursor provider');

const unsupportedStreamResult = async <TEvent>(opts: UpstreamCallOptions): Promise<ProviderStreamResult<TEvent>> => ({
  ok: false,
  modelKey: '',
  response: await opts.recordUpstreamLatency(Promise.resolve(syntheticUnsupportedResponse())),
});

const unsupportedCallResult = async (opts: UpstreamCallOptions): Promise<ProviderCallResult> => ({
  modelKey: '',
  response: await opts.recordUpstreamLatency(Promise.resolve(syntheticUnsupportedResponse())),
});

const unsupportedResponsesResult = async (action: ResponsesAction, opts: UpstreamCallOptions): Promise<ProviderResponsesResult> => ({
  action,
  ok: false,
  modelKey: '',
  response: await opts.recordUpstreamLatency(Promise.resolve(syntheticUnsupportedResponse())),
});
