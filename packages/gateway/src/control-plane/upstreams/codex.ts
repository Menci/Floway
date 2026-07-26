import { resolveControlPlaneFetcher } from './proxy-resolution.ts';
import { upstreamErrorMessage as errorMessage } from './shared.ts';
import type { CtxWithJson } from '../../middleware/zod-validator.ts';
import { getRepo } from '../../repo/index.ts';
import { getRuntimeLocation } from '../../runtime/runtime-info.ts';
import type { codexOAuthAuthorizeUrlBody, codexOAuthExchangeBody, codexOAuthRefreshBody } from '../schemas.ts';
import { warmModelsCache } from '../shared/warm-models-cache.ts';
import type { Fetcher, UpstreamRecord } from '@floway-dev/provider';
import {
  buildCodexAuthorizeUrl,
  type CodexUpstreamConfig,
  type CodexUpstreamState,
  CodexOAuthSessionTerminatedError,
  assertCodexUpstreamState,
  ensureCodexAccessToken,
  importCodexFromAuthJson,
  importCodexFromCallback,
  mintCodexAccessToken,
} from '@floway-dev/provider-codex';

// Codex OAuth under the unified record-body contract. Create and edit
// share one endpoint each: the caller posts the draft record; when
// `record.id !== ''` the produced patch is targeted-persisted, otherwise
// it is only returned for the front-end to merge into its draft.
export const codexOAuthAuthorizeUrl = async (c: CtxWithJson<typeof codexOAuthAuthorizeUrlBody>) => {
  const { challenge, state } = c.req.valid('json');
  return c.json({ authorize_url: buildCodexAuthorizeUrl({ state, codeChallenge: challenge }) });
};

export const codexOAuthExchange = async (c: CtxWithJson<typeof codexOAuthExchangeBody>) => {
  const body = c.req.valid('json');
  const { record } = body;
  if (record.kind !== 'codex') return c.json({ error: 'Upstream is not a Codex upstream' }, 400);

  let fetcher: Fetcher;
  try {
    fetcher = await resolveControlPlaneFetcher({
      override: record.proxy_fallback_list,
      upstreamId: record.id || undefined,
      runtimeLocation: getRuntimeLocation(c.req.raw),
    });
  } catch (err) {
    return c.json({ error: errorMessage(err) }, 400);
  }

  let ingestion: { config: CodexUpstreamConfig; state: CodexUpstreamState };
  try {
    if (body.auth_json !== undefined) {
      ingestion = await importCodexFromAuthJson(body.auth_json);
    } else {
      const cb = body.callback!;
      ingestion = await importCodexFromCallback({ code: cb.code, codeVerifier: cb.verifier, fetcher });
    }
  } catch (err) {
    return c.json({ error: errorMessage(err) }, 400);
  }

  // Edit state: overwrite the credential slice of the stored record.
  // Single-account convention — exchange REPLACES accounts[0], no append.
  if (record.id !== '') {
    const dbRecord = await getRepo().upstreams.getById(record.id);
    if (!dbRecord) return c.json({ error: 'Upstream not found' }, 404);
    if (dbRecord.kind !== 'codex') return c.json({ error: 'Upstream is not a Codex upstream' }, 400);
    const next: UpstreamRecord = {
      ...dbRecord,
      config: ingestion.config,
      state: ingestion.state,
      updatedAt: new Date().toISOString(),
    };
    await getRepo().upstreams.save(next);
    await warmModelsCache(next, c);
  }

  return c.json({
    patch: {
      config: ingestion.config,
      state: ingestion.state,
    },
  });
};

export const codexOAuthRefresh = async (c: CtxWithJson<typeof codexOAuthRefreshBody>) => {
  const { record } = c.req.valid('json');
  if (record.kind !== 'codex') return c.json({ error: 'Upstream is not a Codex upstream' }, 400);
  // Refresh is a stateful action on a persisted row — it delegates to
  // `ensureCodexAccessToken` which reads state from DB, mints, and
  // CAS-writes back with sibling-rotation recovery. Create-state refresh
  // has no target: the just-completed OAuth exchange handed the client a
  // brand-new refresh_token that has no reason to rotate yet, and the
  // front-end does not surface the button until Save lands the row.
  if (record.id === '') return c.json({ error: 'refresh requires a persisted upstream' }, 400);
  assertCodexUpstreamState(record.state);
  const account = record.state.accounts[0];
  if (account.state !== 'active') {
    return c.json({ error: `Codex upstream is ${account.state}; re-run OAuth exchange to recover` }, 400);
  }

  let fetcher: Fetcher;
  try {
    fetcher = await resolveControlPlaneFetcher({
      override: record.proxy_fallback_list,
      upstreamId: record.id,
      runtimeLocation: getRuntimeLocation(c.req.raw),
    });
  } catch (err) {
    return c.json({ error: errorMessage(err) }, 400);
  }

  // Persist callback shape matches `createCodexProvider` — a rotated
  // refresh_token CAS-writes back into the account slot with the just-read
  // state as the expected value. A losing CAS is not an error here: the
  // sibling that won the race already persisted a newer refresh_token, and
  // `ensureCodexAccessToken`'s `recoverFromRefreshRace` picks up the
  // sibling's fresh access token when our mint gets `invalid_grant`.
  const persistRefreshTokenRotation = async (newRefreshToken: string): Promise<void> => {
    const fresh = await getRepo().upstreams.getById(record.id);
    if (!fresh) return;
    assertCodexUpstreamState(fresh.state);
    const next: CodexUpstreamState = {
      accounts: fresh.state.accounts.map(a => a.chatgptAccountId === account.chatgptAccountId
        ? { ...a, refresh_token: newRefreshToken, state_updated_at: new Date().toISOString() }
        : a),
    };
    await getRepo().upstreams.saveState(record.id, next, { expectedState: fresh.state });
  };

  try {
    await ensureCodexAccessToken(record.id, account.chatgptAccountId,
      refreshToken => mintCodexAccessToken(refreshToken, fetcher, persistRefreshTokenRotation),
      true);
  } catch (err) {
    if (err instanceof CodexOAuthSessionTerminatedError) {
      // Terminal flip mirrors `createCodexProvider.persistTerminalState`:
      // clear the cached access token, mark the account refresh_failed so
      // the dashboard renders the red badge and prompts a re-import.
      // Best-effort — a losing CAS means a concurrent rotation already
      // wrote newer state that supersedes ours.
      const fresh = await getRepo().upstreams.getById(record.id);
      if (fresh) {
        assertCodexUpstreamState(fresh.state);
        const next: CodexUpstreamState = {
          accounts: fresh.state.accounts.map(a => a.chatgptAccountId === account.chatgptAccountId
            ? { ...a, state: 'refresh_failed' as const, state_message: err.upstreamMessage, state_updated_at: new Date().toISOString(), accessToken: null }
            : a),
        };
        await getRepo().upstreams.saveState(record.id, next, { expectedState: fresh.state });
      }
      return c.json({ error: `Codex refresh failed: ${err.upstreamMessage}. Re-run OAuth exchange to recover.` }, 400);
    }
    return c.json({ error: errorMessage(err) }, 502);
  }

  const updated = await getRepo().upstreams.getById(record.id);
  if (!updated) return c.json({ error: 'Upstream not found' }, 404);
  return c.json({ patch: { state: updated.state } });
};
