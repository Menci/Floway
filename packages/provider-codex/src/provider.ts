import { ensureCodexAccessToken, mintCodexAccessToken } from './access-token-cache.ts';
import { CodexOAuthSessionTerminatedError } from './auth/oauth.ts';
import { assertCodexUpstreamRecord, type CodexUpstreamConfig } from './config.ts';
import { CODEX_DEFAULT_FLAGS } from './defaults.ts';
import { callCodexAlphaSearch, callCodexResponses, callCodexResponsesCompact, type CodexCallEffects } from './fetch.ts';
import { CODEX_RESPONSES_BOUNDARY } from './interceptors/responses/index.ts';
import type { ResponsesBoundaryCtx } from './interceptors/responses/types.ts';
import { codexRawToProviderModel, fetchCodexCatalog } from './models.ts';
import { assertCodexUpstreamState, type CodexUpstreamState } from './state.ts';
import { runInterceptors } from '@floway-dev/interceptor';
import { toCompactPayloadShape } from '@floway-dev/protocols/responses';
import { getProviderRepo, resolveEffectiveFlags, type ProviderInstance, type Provider, type ProviderCallResult, type ProviderResponsesResult, type ProviderStreamResult, type UpstreamRecord } from '@floway-dev/provider';

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

  // Re-read upstream state on every request rather than capturing the record's
  // state at construction. Refresh-token rotation, terminal-state transitions,
  // and operator re-imports must all be visible to the next in-flight call.
  // Throw rather than guess when the active credential is missing — a row that
  // has lost its credential by id has been hand-edited, and silently using the
  // wrong refresh_token would be worse than failing loudly.
  const readActiveAccount = async () => {
    const fresh = await getProviderRepo().upstreams.getById(record.id);
    if (!fresh) throw new Error(`Codex upstream ${record.id} disappeared mid-request`);
    assertCodexUpstreamState(fresh.state);
    const state = fresh.state;
    const account = state.accounts.find(a => a.chatgptAccountId === accountIdentity.chatgptAccountId);
    if (!account) {
      throw new Error(`Codex upstream ${record.id} state has no credential for account ${accountIdentity.chatgptAccountId}`);
    }
    return { state, account };
  };

  const replaceActiveAccount = (state: CodexUpstreamState, next: CodexUpstreamState['accounts'][number]): CodexUpstreamState => ({
    accounts: state.accounts.map(a => (a.chatgptAccountId === next.chatgptAccountId ? next : a)),
  });

  const persistRefreshTokenRotation = async (newRefreshToken: string): Promise<void> => {
    const { state, account } = await readActiveAccount();
    const next = replaceActiveAccount(state, { ...account, refresh_token: newRefreshToken, state_updated_at: new Date().toISOString() });
    // CAS write keyed on the just-read state. A losing CAS means a concurrent
    // operator re-import (or another isolate's rotation) already advanced the
    // row; their write supersedes ours and no retry is needed.
    await getProviderRepo().upstreams.saveState(record.id, next, { expectedState: state });
  };

  const persistTerminalState = async (newState: 'session_terminated' | 'refresh_failed', message: string): Promise<void> => {
    const { state, account } = await readActiveAccount();
    // Clear any cached access token on the terminal flip — once the credential
    // is dead the cached token is dead too, and leaving it would confuse the
    // dashboard's status panel.
    const next = replaceActiveAccount(state, { ...account, state: newState, state_message: message, state_updated_at: new Date().toISOString(), accessToken: null });
    await getProviderRepo().upstreams.saveState(record.id, next, { expectedState: state });
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
    callRerank: () => Promise.reject(new Error('Codex provider does not support callRerank')),
  };

  return {
    upstream: record.id,
    kind: 'codex',
    name: record.name,
    disabledPublicModelIds: record.disabledPublicModelIds,
    modelPrefix: record.modelPrefix,
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
