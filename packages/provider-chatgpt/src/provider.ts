import { ensureChatGPTAccessToken, mintChatGPTAccessToken } from './access-token.ts';
import { ChatGPTOAuthSessionTerminatedError } from './auth/oauth.ts';
import { assertChatGPTUpstreamRecord, type ChatGPTUpstreamConfig } from './config.ts';
import { CHATGPT_DEFAULT_FLAGS } from './defaults.ts';
import { callChatGPTAlphaSearch, callChatGPTOpenAIImagesEdits, callChatGPTOpenAIImagesGenerations, callChatGPTOpenAIResponses, callChatGPTOpenAIResponsesCompact, type ChatGPTCallEffects } from './fetch.ts';
import { CHATGPT_OPENAI_RESPONSES_BOUNDARY } from './interceptors/openai-responses/index.ts';
import type { OpenAIResponsesBoundaryCtx } from './interceptors/openai-responses/types.ts';
import { chatgptImageProviderModel, chatgptPlanSupportsImages, chatgptRawToProviderModel, fetchChatGPTCatalog } from './models.ts';
import { createChatGPTPipelines } from './pipelines.ts';
import { assertChatGPTUpstreamState, findChatGPTAccountIndex, persistChatGPTRefreshTokenRotation, persistChatGPTTerminalState } from './state.ts';
import { runChatGPTScheduledTask } from './usage-probe.ts';
import { runInterceptors } from '@floway-dev/interceptor';
import { getProviderRepo, resolveEffectiveFlags, type ProviderInstance, type Provider, type ProviderCallResult, type ProviderOpenAIResponsesResult, type ProviderStreamResult, type UpstreamRecord } from '@floway-dev/provider';

// https://github.com/openai/codex/blob/c607da9f371bb66a41cc772c6ddf1989d28137d3/codex-rs/codex-api/src/requests/headers.rs#L5-L12
// https://github.com/openai/codex/blob/c607da9f371bb66a41cc772c6ddf1989d28137d3/codex-rs/codex-api/src/endpoint/responses.rs#L87-L96
// https://github.com/openai/codex/blob/c607da9f371bb66a41cc772c6ddf1989d28137d3/codex-rs/core/src/responses_metadata.rs#L255-L270
// https://github.com/openai/codex/blob/bd8fc9adb93fa5bc0a69b396bd5ac78a5ec14487/codex-rs/codex-api/src/requests/headers.rs#L5-L16
// https://github.com/openai/codex/blob/646f7c0a91b8e327d263335da68ae8ef212895ce/codex-rs/ext/image-generation/src/backend.rs#L81-L89
const INBOUND_HEADER_ALLOWLIST = [
  'originator',
  'session-id',
  'session_id',
  'thread-id',
  'x-client-request-id',
  'x-codex-image-turn-id',
  'x-codex-turn-metadata',
  'x-codex-window-id',
] as const;

export const createChatGPTProvider = (record: UpstreamRecord): Provider => {
  assertChatGPTUpstreamRecord(record);
  assertChatGPTUpstreamState(record.state);
  const config: ChatGPTUpstreamConfig = record.config;
  // Always operates on the first account in the pool. The schema carries an
  // array so a future fan-out can pick a different active account per call
  // without a wire migration.
  const accountIdentity = config.accounts[0];

  // Computed once per provider instance: only the upstream layer applies
  // (no per-model override layer). Threaded into every ProviderModel emitted
  // by getProvidedModels so interceptors can read the effective flag set
  // without re-resolving.
  const enabledFlags = resolveEffectiveFlags([CHATGPT_DEFAULT_FLAGS, record.flagOverrides]);

  // Locate the pool's active credential inside a state document. Throw rather
  // than guess when it is missing — a row that has lost its credential by id
  // has been hand-edited, and silently using the wrong refresh_token would be
  // worse than failing loudly.
  const locateActiveAccount = (raw: unknown) => {
    assertChatGPTUpstreamState(raw);
    const accountIndex = findChatGPTAccountIndex(raw, accountIdentity.chatgptAccountId);
    if (accountIndex < 0) {
      throw new Error(`ChatGPT upstream ${record.id} state has no credential for account ${accountIdentity.chatgptAccountId}`);
    }
    return { state: raw, accountIndex, account: raw.accounts[accountIndex]! };
  };

  // Re-read upstream state on every request rather than capturing the record's
  // state at construction. Refresh-token rotation, terminal-state transitions,
  // and operator re-imports must all be visible to the next in-flight call.
  const readActiveAccount = async () => {
    const fresh = await getProviderRepo().upstreams.getById(record.id);
    if (!fresh) throw new Error(`ChatGPT upstream ${record.id} disappeared mid-request`);
    return locateActiveAccount(fresh.state);
  };

  const effects: ChatGPTCallEffects = {
    persistRefreshTokenRotation: newRefreshToken =>
      persistChatGPTRefreshTokenRotation(record.id, accountIdentity.chatgptAccountId, newRefreshToken, { onMissing: 'throw' }),
    persistTerminalState: (newState, message) =>
      persistChatGPTTerminalState(record.id, accountIdentity.chatgptAccountId, newState, message, { onMissing: 'throw' }),
  };

  const instance: ProviderInstance = {
    runScheduledTask: options => runChatGPTScheduledTask(record, options),
    getProvidedModels: async fetcher => {
      // A model-list refresh is the first thing a brand-new ChatGPT upstream
      // does, and it is the only place outside the data plane that mints an
      // access token. If the refresh_token has been revoked upstream, the
      // mint throws ChatGPTOAuthSessionTerminatedError; flip the row to
      // `refresh_failed` so the dashboard stops claiming the credential is
      // active, then rethrow so the caller's models-cache records the
      // failure and surfaces it to the operator.
      let access;
      try {
        access = await ensureChatGPTAccessToken(record.id, accountIdentity.chatgptAccountId, refreshToken =>
          mintChatGPTAccessToken(refreshToken, fetcher, effects.persistRefreshTokenRotation));
      } catch (err) {
        if (err instanceof ChatGPTOAuthSessionTerminatedError) {
          await effects.persistTerminalState('refresh_failed', err.upstreamMessage);
        }
        throw err;
      }
      const raw = await fetchChatGPTCatalog({ accessToken: access.token, accountId: accountIdentity.chatgptAccountId, fetcher });
      // Surface every model the upstream returns, including ones whose
      // ChatGPT-side `visibility` is `hide` (e.g. codex-auto-review). The
      // operator's gateway is its own surface — they can dispatch to those
      // models even though the ChatGPT UI hides them — and the dashboard
      // toggles them per-upstream when needed.
      const models = raw.map(r => chatgptRawToProviderModel(r, enabledFlags));
      if (chatgptPlanSupportsImages(access.planType ?? accountIdentity.planType ?? undefined)) models.push(chatgptImageProviderModel(enabledFlags));
      return models;
    },

    callAlphaSearch: async (model, body, signal, opts) => {
      const { account } = await readActiveAccount();
      return await callChatGPTAlphaSearch({
        upstreamId: record.id,
        account,
        model,
        headers: new Headers(opts.headers),
        signal,
        effects,
        call: opts,
        body,
      });
    },

    callOpenAIResponses: async (model, body, action, signal, opts) => {
      const ctx: OpenAIResponsesBoundaryCtx = {
        payload: { ...body, model: model.id },
        headers: new Headers(opts.headers),
        model,
        action,
      };
      return await runInterceptors<OpenAIResponsesBoundaryCtx, object, ProviderOpenAIResponsesResult>(
        ctx, {}, CHATGPT_OPENAI_RESPONSES_BOUNDARY, async () => {
          const { account } = await readActiveAccount();
          const { model: _ignored, ...wireBody } = ctx.payload;
          const backendCallBase = { upstreamId: record.id, account, model, headers: ctx.headers, signal, effects, call: opts };
          switch (ctx.action) {
          case 'compact':
            // The fetch boundary selects the private wire format before compact
            // projection so interceptor-provided tools and instructions survive.
            return { action: 'compact', ...(await callChatGPTOpenAIResponsesCompact({ ...backendCallBase, body: wireBody })) };
          case 'generate':
            return { action: 'generate', ...(await callChatGPTOpenAIResponses({ ...backendCallBase, body: wireBody })) };
          default:
            ctx.action satisfies never;
            throw new Error(`Unhandled OpenAIResponsesAction: ${ctx.action as string}`);
          }
        },
      );
    },

    // ChatGPT exposes OpenAI Responses and its provider-owned image endpoints. The
    // remaining surfaces are unreachable through the advertised catalog, but
    // a stray dispatch must still surface as a structured 405.
    callAnthropicMessages: () => unsupportedStreamResult(),
    callAnthropicMessagesCountTokens: () => unsupportedCallResult(),
    callOpenAICompletions: () => unsupportedCallResult(),
    callOpenAIChatCompletions: () => unsupportedStreamResult(),
    callOpenAIEmbeddings: () => unsupportedCallResult(),
    callOpenAIImagesGenerations: async (model, body, signal, opts) => {
      const { account } = await readActiveAccount();
      return await callChatGPTOpenAIImagesGenerations({ upstreamId: record.id, account, model, headers: opts.headers, signal, effects, call: opts, body, fallbackPlanType: accountIdentity.planType ?? undefined });
    },
    callOpenAIImagesEdits: async (model, request, signal, opts) => {
      const { account } = await readActiveAccount();
      return await callChatGPTOpenAIImagesEdits({ upstreamId: record.id, account, model, headers: opts.headers, signal, effects, call: opts, request, fallbackPlanType: accountIdentity.planType ?? undefined });
    },
    callOpenAIAudioTranscriptions: () => unsupportedCallResult(),
    callRerank: () => Promise.reject(new Error('ChatGPT provider does not support callRerank')),
  };

  return {
    upstreamId: record.id,
    kind: 'chatgpt',
    name: record.name,
    inboundHeaderAllowlist: INBOUND_HEADER_ALLOWLIST,
    disabledPublicModelIds: record.disabledPublicModelIds,
    modelPrefix: record.modelPrefix,
    modelsCache: record.modelsCache,
    pipelines: createChatGPTPipelines({ upstreamId: record.id, fallbackPlanType: accountIdentity.planType ?? undefined, readAccount: async () => (await readActiveAccount()).account, effects }),
    instance,
  };
};

const synthetic405 = (): Response => new Response(
  JSON.stringify({ error: { type: 'method_not_allowed', message: 'Endpoint not supported by ChatGPT provider' } }),
  { status: 405, headers: { 'content-type': 'application/json' } },
);

const unsupportedStreamResult = <TEvent>(): Promise<ProviderStreamResult<TEvent>> =>
  Promise.resolve({ ok: false, modelKey: '', response: synthetic405() });

const unsupportedCallResult = (): Promise<ProviderCallResult> =>
  Promise.resolve({ modelKey: '', response: synthetic405() });
