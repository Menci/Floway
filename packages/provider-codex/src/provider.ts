import { ensureCodexAccessToken, mintCodexAccessToken } from './access-token.ts';
import { CodexOAuthSessionTerminatedError } from './auth/oauth.ts';
import { assertCodexUpstreamRecord, type CodexUpstreamConfig } from './config.ts';
import { CODEX_DEFAULT_FLAGS } from './defaults.ts';
import { callCodexAlphaSearch, callCodexResponses, callCodexResponsesCompact, type CodexCallEffects } from './fetch.ts';
import { CODEX_RESPONSES_BOUNDARY } from './interceptors/responses/index.ts';
import type { ResponsesBoundaryCtx } from './interceptors/responses/types.ts';
import { codexRawToProviderModel, fetchCodexCatalog } from './models.ts';
import { assertCodexUpstreamState, findCodexAccountIndex, replaceCodexAccount } from './state.ts';
import { runInterceptors } from '@floway-dev/interceptor';
import { toCompactPayloadShape } from '@floway-dev/protocols/responses';
import { getProviderRepo, resolveEffectiveFlags, type ProviderInstance, type Provider, type ProviderCallResult, type ProviderResponsesResult, type ProviderStreamResult, type UpstreamRecord } from '@floway-dev/provider';

// https://github.com/openai/codex/blob/c607da9f371bb66a41cc772c6ddf1989d28137d3/codex-rs/codex-api/src/requests/headers.rs#L5-L12
// https://github.com/openai/codex/blob/c607da9f371bb66a41cc772c6ddf1989d28137d3/codex-rs/codex-api/src/endpoint/responses.rs#L87-L96
// https://github.com/openai/codex/blob/c607da9f371bb66a41cc772c6ddf1989d28137d3/codex-rs/core/src/responses_metadata.rs#L255-L270
// https://github.com/openai/codex/blob/bd8fc9adb93fa5bc0a69b396bd5ac78a5ec14487/codex-rs/codex-api/src/requests/headers.rs#L5-L16
const INBOUND_HEADER_ALLOWLIST = [
  'session-id',
  'session_id',
  'thread-id',
  'x-client-request-id',
  'x-codex-turn-metadata',
  'x-codex-window-id',
] as const;

export const createCodexProvider = (record: UpstreamRecord): Provider => {
  assertCodexUpstreamRecord(record);
  assertCodexUpstreamState(record.state);
  const config: CodexUpstreamConfig = record.config;
  // Always operates on the first account in the pool. The schema carries an
  // array so a future fan-out can pick a different active account per call
  // without a wire migration.
  const accountIdentity = config.accounts[0];

  // Computed once per provider instance: only the upstream layer applies
  // (no per-model override layer). Threaded into every ProviderModel emitted
  // by getProvidedModels so interceptors can read the effective flag set
  // without re-resolving.
  const enabledFlags = resolveEffectiveFlags([CODEX_DEFAULT_FLAGS, record.flagOverrides]);

  // Locate the pool's active credential inside a state document. Throw rather
  // than guess when it is missing — a row that has lost its credential by id
  // has been hand-edited, and silently using the wrong refresh_token would be
  // worse than failing loudly.
  const locateActiveAccount = (raw: unknown) => {
    assertCodexUpstreamState(raw);
    const accountIndex = findCodexAccountIndex(raw, accountIdentity.chatgptAccountId);
    if (accountIndex < 0) {
      throw new Error(`Codex upstream ${record.id} state has no credential for account ${accountIdentity.chatgptAccountId}`);
    }
    return { state: raw, accountIndex, account: raw.accounts[accountIndex]! };
  };

  // Re-read upstream state on every request rather than capturing the record's
  // state at construction. Refresh-token rotation, terminal-state transitions,
  // and operator re-imports must all be visible to the next in-flight call.
  const readActiveAccount = async () => {
    const fresh = await getProviderRepo().upstreams.getById(record.id);
    if (!fresh) throw new Error(`Codex upstream ${record.id} disappeared mid-request`);
    return locateActiveAccount(fresh.state);
  };

  const persistRefreshTokenRotation = async (newRefreshToken: string): Promise<void> => {
    const rotatedAt = new Date().toISOString();
    await getProviderRepo().upstreams.saveState(record.id, current => {
      const { state, accountIndex } = locateActiveAccount(current);
      return replaceCodexAccount(state, accountIndex, account => ({ ...account, refresh_token: newRefreshToken, state_updated_at: rotatedAt }));
    });
  };

  const persistTerminalState = async (newState: 'session_terminated' | 'refresh_failed', message: string): Promise<void> => {
    const flippedAt = new Date().toISOString();
    await getProviderRepo().upstreams.saveState(record.id, current => {
      const { state, accountIndex } = locateActiveAccount(current);
      // Clear any cached access token on the terminal flip — once the credential
      // is dead the cached token is dead too, and leaving it would confuse the
      // dashboard's status panel.
      return replaceCodexAccount(state, accountIndex, account => ({ ...account, state: newState, state_message: message, state_updated_at: flippedAt, accessToken: null }));
    });
  };

  const effects: CodexCallEffects = { persistRefreshTokenRotation, persistTerminalState };

  const instance: ProviderInstance = {
    getProvidedModels: async fetcher => {
      // A model-list refresh is the first thing a brand-new Codex upstream
      // does, and it is the only place outside the data plane that mints an
      // access token. If the refresh_token has been revoked upstream, the
      // mint throws CodexOAuthSessionTerminatedError; flip the row to
      // `refresh_failed` so the dashboard stops claiming the credential is
      // active, then rethrow so the caller's models-cache records the
      // failure and surfaces it to the operator.
      let access;
      try {
        access = await ensureCodexAccessToken(record.id, accountIdentity.chatgptAccountId, refreshToken =>
          mintCodexAccessToken(refreshToken, fetcher, persistRefreshTokenRotation));
      } catch (err) {
        if (err instanceof CodexOAuthSessionTerminatedError) {
          await persistTerminalState('refresh_failed', err.upstreamMessage);
        }
        throw err;
      }
      const raw = await fetchCodexCatalog({ accessToken: access.token, accountId: accountIdentity.chatgptAccountId, fetcher });
      // Surface every model the upstream returns, including ones whose
      // ChatGPT-side `visibility` is `hide` (e.g. codex-auto-review). The
      // operator's gateway is its own surface — they can dispatch to those
      // models even though the ChatGPT UI hides them — and the dashboard
      // toggles them per-upstream when needed.
      return raw.map(r => codexRawToProviderModel(r, enabledFlags));
    },

    callAlphaSearch: async (model, body, signal, opts) => {
      const { account } = await readActiveAccount();
      return await callCodexAlphaSearch({
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

    callResponses: async (model, body, action, signal, opts) => {
      const ctx: ResponsesBoundaryCtx = {
        payload: { ...body, model: model.id },
        headers: new Headers(opts.headers),
        model,
        action,
      };
      return await runInterceptors<ResponsesBoundaryCtx, object, ProviderResponsesResult>(
        ctx, {}, CODEX_RESPONSES_BOUNDARY, async () => {
          const { account } = await readActiveAccount();
          const { model: _ignored, ...wireBody } = ctx.payload;
          const backendCallBase = { upstreamId: record.id, account, model, headers: ctx.headers, signal, effects, call: opts };
          switch (ctx.action) {
          case 'compact':
            // Narrow to the compact wire shape — defends against a future
            // interceptor that flips `ctx.action` from 'generate' to 'compact'
            // mid-chain and leaves the generate-shaped body (tools, reasoning,
            // etc.) in place.
            return { action: 'compact', ...(await callCodexResponsesCompact({ ...backendCallBase, body: toCompactPayloadShape(wireBody) })) };
          case 'generate':
            return { action: 'generate', ...(await callCodexResponses({ ...backendCallBase, body: wireBody })) };
          default:
            ctx.action satisfies never;
            throw new Error(`Unhandled ResponsesAction: ${ctx.action as string}`);
          }
        },
      );
    },

    // Codex upstream only exposes /responses; getProvidedModels advertises
    // that single endpoint and no other entry point is reachable. The data
    // plane never routes these surfaces here in practice, but a stray
    // dispatch must surface as a 405 carrying a proper JSON error rather
    // than letting a raw stack trace bubble up the boundary.
    callMessages: () => unsupportedStreamResult(),
    callMessagesCountTokens: () => unsupportedCallResult(),
    callCompletions: () => unsupportedCallResult(),
    callChatCompletions: () => unsupportedStreamResult(),
    callEmbeddings: () => unsupportedCallResult(),
    callImagesGenerations: () => unsupportedCallResult(),
    callImagesEdits: () => unsupportedCallResult(),
    callAudioTranscriptions: () => unsupportedCallResult(),
    callRerank: () => Promise.reject(new Error('Codex provider does not support callRerank')),
  };

  return {
    upstreamId: record.id,
    kind: 'codex',
    name: record.name,
    inboundHeaderAllowlist: INBOUND_HEADER_ALLOWLIST,
    disabledPublicModelIds: record.disabledPublicModelIds,
    modelPrefix: record.modelPrefix,
    modelsCache: record.modelsCache,
    instance,
  };
};

const synthetic405 = (): Response => new Response(
  JSON.stringify({ error: { type: 'method_not_allowed', message: 'Endpoint not supported by codex provider' } }),
  { status: 405, headers: { 'content-type': 'application/json' } },
);

const unsupportedStreamResult = <TEvent>(): Promise<ProviderStreamResult<TEvent>> =>
  Promise.resolve({ ok: false, modelKey: '', response: synthetic405() });

const unsupportedCallResult = (): Promise<ProviderCallResult> =>
  Promise.resolve({ modelKey: '', response: synthetic405() });
