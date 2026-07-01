import { ensureCodexAccessToken, mintCodexAccessToken } from './access-token-cache.ts';
import { CodexOAuthSessionTerminatedError } from './auth/oauth.ts';
import { assertCodexUpstreamRecord, type CodexUpstreamConfig } from './config.ts';
import { callCodexResponses, callCodexResponsesCompact, type CodexCallEffects } from './fetch.ts';
import { CODEX_RESPONSES_BOUNDARY } from './interceptors/responses/index.ts';
import type { ResponsesBoundaryCtx } from './interceptors/responses/types.ts';
import { codexRawToProviderModel, fetchCodexCatalog } from './models.ts';
import { pricingForCodexModelKey } from './pricing.ts';
import { assertCodexUpstreamState, type CodexUpstreamState } from './state.ts';
import { runInterceptors } from '@floway-dev/interceptor';
import { toCompactPayloadShape } from '@floway-dev/protocols/responses';
import { defaultsForProvider, getProviderRepo, resolveEffectiveFlags, type ProviderInstance, type Provider, type ProviderCallResult, type ProviderResponsesResult, type ProviderStreamResult, type UpstreamCallOptions, type UpstreamRecord } from '@floway-dev/provider';

export const createCodexProvider = async (record: UpstreamRecord): Promise<Provider> => {
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
  const enabledFlags = resolveEffectiveFlags(defaultsForProvider('codex'), [record.flagOverrides]);

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

    // Codex itself is a flat-fee subscription, but the dashboard reports
    // notional cost per request as if the operator were paying OpenAI's
    // public API rates. The table lives in ./pricing.ts.
    getPricingForModelKey: pricingForCodexModelKey,

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
    // than letting a raw stack trace bubble up the boundary. The synthetic
    // response still flows through the per-call latency recorder so the
    // gateway's wrap-once contract holds even for these stubs.
    callMessages: (_model, _body, _signal, opts) => unsupportedStreamResult(opts),
    callMessagesCountTokens: (_model, _body, _signal, opts) => unsupportedCallResult(opts),
    callCompletions: (_model, _body, _signal, opts) => unsupportedCallResult(opts),
    callChatCompletions: (_model, _body, _signal, opts) => unsupportedStreamResult(opts),
    callEmbeddings: (_model, _body, _signal, opts) => unsupportedCallResult(opts),
    callImagesGenerations: (_model, _body, _signal, opts) => unsupportedCallResult(opts),
    callImagesEdits: (_model, _body, _signal, opts) => unsupportedCallResult(opts),
  };

  return {
    upstream: record.id,
    kind: 'codex',
    name: record.name,
    disabledPublicModelIds: record.disabledPublicModelIds,
    modelPrefix: record.modelPrefix,
    instance,
    supportsResponsesItemReference: false,
  };
};

const synthetic405 = (): Response => new Response(
  JSON.stringify({ error: { type: 'method_not_allowed', message: 'Endpoint not supported by codex provider' } }),
  { status: 405, headers: { 'content-type': 'application/json' } },
);

const unsupportedStreamResult = async <TEvent>(opts: UpstreamCallOptions): Promise<ProviderStreamResult<TEvent>> => ({
  ok: false,
  modelKey: '',
  response: await opts.recordUpstreamLatency(Promise.resolve(synthetic405())),
});

const unsupportedCallResult = async (opts: UpstreamCallOptions): Promise<ProviderCallResult> => ({
  modelKey: '',
  response: await opts.recordUpstreamLatency(Promise.resolve(synthetic405())),
});
