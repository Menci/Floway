import { resolveControlPlaneFetcher } from './proxy-resolution.ts';
import { upstreamErrorMessage as errorMessage } from './shared.ts';
import { userFromContext } from '../../middleware/auth.ts';
import type { CtxWithJson } from '../../middleware/zod-validator.ts';
import { getRepo } from '../../repo/index.ts';
import { getRuntimeLocation } from '../../runtime/runtime-info.ts';
import type { claudeCodeOAuthAuthorizeUrlBody, claudeCodeOAuthExchangeBody, claudeCodeOAuthRefreshBody, claudeCodeProbeBody, claudeCodeSetupTokenAuthorizeUrlBody, claudeCodeSetupTokenExchangeBody } from '../schemas.ts';
import { warmModelsCache } from '../shared/warm-models-cache.ts';
import type { Fetcher, UpstreamRecord } from '@floway-dev/provider';
import {
  type ClaudeCodeAccountCredential,
  type ClaudeCodeUpstreamConfig,
  type ClaudeCodeUpstreamState,
  ClaudeCodeOAuthSessionTerminatedError,
  buildClaudeCodeAuthorizeUrl,
  ensureClaudeCodeAccessToken,
  fetchClaudeCodeUsageProbe,
  importClaudeCodeFromCallback,
  importClaudeCodeFromCredentialsJson,
  importClaudeCodeFromSetupTokenCallback,
  logInfo,
  readClaudeCodeUpstreamState,
} from '@floway-dev/provider-claude-code';

// Claude Code OAuth + setup-token + probe endpoints under the unified
// record-body contract. Create and edit share one endpoint each: the
// caller posts the draft record; when `record.id !== ''` the produced
// patch is targeted-persisted, otherwise only returned for the
// front-end to merge into its draft.

export const claudeCodeOAuthAuthorizeUrl = async (c: CtxWithJson<typeof claudeCodeOAuthAuthorizeUrlBody>) => {
  const { challenge, state } = c.req.valid('json');
  const authorize_url = buildClaudeCodeAuthorizeUrl({ state, codeChallenge: challenge, kind: 'oauth' });
  return c.json({ authorize_url });
};

export const claudeCodeSetupTokenAuthorizeUrl = async (c: CtxWithJson<typeof claudeCodeSetupTokenAuthorizeUrlBody>) => {
  const { challenge, state } = c.req.valid('json');
  const authorize_url = buildClaudeCodeAuthorizeUrl({ state, codeChallenge: challenge, kind: 'setup-token' });
  return c.json({ authorize_url });
};

export const claudeCodeOAuthExchange = async (c: CtxWithJson<typeof claudeCodeOAuthExchangeBody>) => {
  const body = c.req.valid('json');
  const { record } = body;
  if (record.kind !== 'claude-code') return c.json({ error: 'Upstream is not a Claude Code upstream' }, 400);

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

  let ingestion: { config: ClaudeCodeUpstreamConfig; state: ClaudeCodeUpstreamState };
  try {
    if (body.credentials_json !== undefined) {
      ingestion = await importClaudeCodeFromCredentialsJson(body.credentials_json, fetcher);
    } else {
      const cb = body.callback!;
      ingestion = await importClaudeCodeFromCallback({ code: cb.code, pkceVerifier: cb.verifier, state: cb.state, fetcher });
    }
  } catch (err) {
    return c.json({ error: errorMessage(err) }, 400);
  }

  if (record.id !== '') {
    const dbRecord = await getRepo().upstreams.getById(record.id);
    if (!dbRecord) return c.json({ error: 'Upstream not found' }, 404);
    if (dbRecord.kind !== 'claude-code') return c.json({ error: 'Upstream is not a Claude Code upstream' }, 400);
    const next: UpstreamRecord = {
      ...dbRecord,
      config: ingestion.config,
      state: ingestion.state,
      updatedAt: new Date().toISOString(),
    };
    await getRepo().upstreams.save(next);
    await warmModelsCache(next, c);
  }

  return c.json({ patch: { config: ingestion.config, state: ingestion.state } });
};

export const claudeCodeSetupTokenExchange = async (c: CtxWithJson<typeof claudeCodeSetupTokenExchangeBody>) => {
  const { record, callback } = c.req.valid('json');
  if (record.kind !== 'claude-code') return c.json({ error: 'Upstream is not a Claude Code upstream' }, 400);

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

  let ingestion: { config: ClaudeCodeUpstreamConfig; state: ClaudeCodeUpstreamState };
  try {
    ingestion = await importClaudeCodeFromSetupTokenCallback({
      code: callback.code,
      pkceVerifier: callback.verifier,
      state: callback.state,
      fetcher,
    });
  } catch (err) {
    return c.json({ error: errorMessage(err) }, 400);
  }

  if (record.id !== '') {
    const dbRecord = await getRepo().upstreams.getById(record.id);
    if (!dbRecord) return c.json({ error: 'Upstream not found' }, 404);
    if (dbRecord.kind !== 'claude-code') return c.json({ error: 'Upstream is not a Claude Code upstream' }, 400);
    const next: UpstreamRecord = {
      ...dbRecord,
      config: ingestion.config,
      state: ingestion.state,
      updatedAt: new Date().toISOString(),
    };
    await getRepo().upstreams.save(next);
    await warmModelsCache(next, c);
  }

  return c.json({ patch: { config: ingestion.config, state: ingestion.state } });
};

export const claudeCodeOAuthRefresh = async (c: CtxWithJson<typeof claudeCodeOAuthRefreshBody>) => {
  const { record } = c.req.valid('json');
  if (record.kind !== 'claude-code') return c.json({ error: 'Upstream is not a Claude Code upstream' }, 400);
  // Refresh delegates to the data plane's `ensureClaudeCodeAccessToken`
  // with `force: true` so operator clicks and data-plane requests share
  // the same rotation + sibling-race recovery path (no duplicated CAS
  // logic, no divergence). Create-state refresh has no target — the
  // just-completed OAuth exchange handed the client a brand-new
  // refresh_token that has no reason to rotate yet.
  if (record.id === '') return c.json({ error: 'refresh requires a persisted upstream' }, 400);

  const parsedState = readClaudeCodeUpstreamState(record.state);
  const account = parsedState.accounts[0];
  if (account.state !== 'active') {
    return c.json({ error: `Claude Code upstream is ${account.state}; re-run OAuth exchange to recover` }, 400);
  }
  if (account.tokenKind === 'setup-token') {
    return c.json({ error: 'Setup-token credentials cannot be refreshed; re-run setup-token exchange to rotate' }, 400);
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

  try {
    // `ensureClaudeCodeAccessToken` handles the whole flow: read state,
    // CAS-write the rotated refresh_token alongside the fresh access
    // token, and flip the row to refresh_failed on a terminal OAuth
    // error. All this handler contributes is the HTTP framing.
    await ensureClaudeCodeAccessToken({ upstreamId: record.id, repo: getRepo().upstreams, fetcher, force: true });
  } catch (err) {
    if (err instanceof ClaudeCodeOAuthSessionTerminatedError) {
      return c.json({ error: `Claude Code refresh failed: ${err.upstreamMessage}. Re-run OAuth exchange to recover.` }, 400);
    }
    return c.json({ error: errorMessage(err) }, 502);
  }

  const updated = await getRepo().upstreams.getById(record.id);
  if (!updated) return c.json({ error: 'Upstream not found' }, 404);
  return c.json({ patch: { state: updated.state } });
};

export const claudeCodeProbe = async (c: CtxWithJson<typeof claudeCodeProbeBody>) => {
  const { record } = c.req.valid('json');
  if (record.kind !== 'claude-code') return c.json({ error: 'Quota probe is only supported for claude-code upstreams' }, 400);
  const actor = userFromContext(c).id;

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

  // Resolving a fresh access token demands DB access (the token cache
  // and CAS-guarded refresh live there), so probe on a create-state
  // record requires that the caller has ensured a fresh access_token
  // sits in draft.state.accounts[0].accessToken from the OAuth
  // exchange step. In edit state, we can call the standard cache
  // helper that reads / refreshes from DB.
  let accessToken: string;
  try {
    if (record.id !== '') {
      const access = await ensureClaudeCodeAccessToken({
        upstreamId: record.id,
        repo: getRepo().upstreams,
        fetcher,
      });
      accessToken = access.entry.token;
    } else {
      const parsedState = readClaudeCodeUpstreamState(record.state);
      const account = parsedState.accounts[0];
      if (!account.accessToken?.token) {
        return c.json({ error: 'Draft account has no fresh access token; run OAuth refresh first' }, 400);
      }
      accessToken = account.accessToken.token;
    }
  } catch (err) {
    logInfo('claude_code_admin_action', { upstream_id: record.id, action: 'quota_probe', actor, outcome: 'error', error: errorMessage(err) });
    if (err instanceof ClaudeCodeOAuthSessionTerminatedError) {
      return c.json({ error: `Claude Code refresh failed: ${err.upstreamMessage}` }, 503);
    }
    return c.json({ error: errorMessage(err) }, 502);
  }

  let probe;
  try {
    probe = await fetchClaudeCodeUsageProbe(accessToken, fetcher);
  } catch (err) {
    logInfo('claude_code_admin_action', { upstream_id: record.id, action: 'quota_probe', actor, outcome: 'error', error: errorMessage(err) });
    return c.json({ error: errorMessage(err) }, 502);
  }

  const snapshotPatch = {
    usageProbeSnapshot: { fetchedAt: Date.parse(probe.fetched_at), data: probe.body },
  };
  const mergeSnapshotInto = (state: ClaudeCodeUpstreamState): ClaudeCodeUpstreamState => ({
    ...state,
    accounts: state.accounts.map((a, i): ClaudeCodeAccountCredential => i === 0 ? { ...a, ...snapshotPatch } : a),
  });

  // Merge the freshly-fetched snapshot into the caller's draft state so the
  // response carries a whole state slot the caller can hand to its uniform
  // patch merger — the wire contract stays symmetric with refresh/exchange
  // instead of asking the client to hand-merge into accounts[0].
  const merged = mergeSnapshotInto(readClaudeCodeUpstreamState(record.state));

  // The snapshot rides on top of whatever state is current at write time, so a
  // concurrent rotation neither loses its own write nor is overwritten by this
  // one. A draft that has never been saved has no row to write to.
  if (record.id !== '') {
    await getRepo().upstreams.saveState(record.id, current =>
      mergeSnapshotInto(readClaudeCodeUpstreamState(current)));
  }

  logInfo('claude_code_admin_action', { upstream_id: record.id, action: 'quota_probe', actor, outcome: 'ok' });
  return c.json({
    fetched_at: probe.fetched_at,
    body: probe.body,
    patch: { state: merged },
  });
};
