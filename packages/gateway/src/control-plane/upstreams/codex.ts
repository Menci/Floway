import { resolveControlPlaneFetcher } from './proxy-resolution.ts';
import { upstreamErrorMessage as errorMessage } from './shared.ts';
import type { CtxWithJson } from '../../middleware/zod-validator.ts';
import { getRepo } from '../../repo/index.ts';
import { getRuntimeLocation } from '../../runtime/runtime-info.ts';
import type { codexImportExchangeBody, codexImportPreviewBody, codexOAuthAuthorizeUrlBody, codexOAuthRefreshBody } from '../schemas.ts';
import { warmModelsCache } from '../shared/warm-models-cache.ts';
import type { Fetcher, UpstreamRecord } from '@floway-dev/provider';
import {
  buildCodexAuthorizeUrl,
  type CodexUpstreamConfig,
  type CodexUpstreamState,
  CodexOAuthSessionTerminatedError,
  assertCodexUpstreamState,
  ensureCodexAccessToken,
  importCodexFromCallback,
  importCodexFromJson,
  importCodexFromManual,
  mintCodexAccessToken,
  persistCodexRefreshFailure,
  persistCodexRefreshTokenRotation,
  previewCodexJson,
} from '@floway-dev/provider-codex';

// Codex credential import under the unified record-body contract. Create and
// edit share one endpoint each: the caller posts the draft record; when
// `record.id !== ''` the produced patch is targeted-persisted, otherwise it is
// only returned for the front-end to merge into its draft.
export const codexOAuthAuthorizeUrl = async (c: CtxWithJson<typeof codexOAuthAuthorizeUrlBody>) => {
  const { challenge, state } = c.req.valid('json');
  return c.json({ authorize_url: buildCodexAuthorizeUrl({ state, codeChallenge: challenge }) });
};

// Reads a pasted document and reports the accounts in it so the operator can
// pick one. Takes no record and persists nothing — it is the step before any
// upstream is involved, which is also why its response carries identity and
// lifecycle only and never credential material.
export const codexImportPreview = async (c: CtxWithJson<typeof codexImportPreviewBody>) => {
  const { raw_json: rawJson } = c.req.valid('json');
  try {
    return c.json({ candidates: await previewCodexJson(rawJson) });
  } catch (err) {
    return c.json({ error: errorMessage(err) }, 400);
  }
};

export const codexImportExchange = async (c: CtxWithJson<typeof codexImportExchangeBody>) => {
  const body = c.req.valid('json');
  const { record } = body;
  if (record.kind !== 'codex') return c.json({ error: 'Upstream is not a Codex upstream' }, 400);

  let ingestion: { config: CodexUpstreamConfig; state: CodexUpstreamState };
  try {
    if (body.json !== undefined) {
      ingestion = await importCodexFromJson(body.json.raw_json, body.json.source_index);
    } else if (body.manual !== undefined) {
      ingestion = await importCodexFromManual(body.manual);
    } else {
      // The callback is the only source that talks to auth.openai.com, so it
      // is also the only one that needs the upstream's egress chain resolved.
      const cb = body.callback!;
      const fetcher: Fetcher = await resolveControlPlaneFetcher({
        override: record.proxy_fallback_list,
        upstreamId: record.id || undefined,
        runtimeLocation: getRuntimeLocation(c.req.raw),
      });
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
  // An access-only credential has nothing to refresh from, so the answer is
  // the same one the data plane gives: re-import.
  if (account.refresh_token === null) {
    return c.json({ error: 'Codex access-only credentials cannot be refreshed; re-import the credential' }, 400);
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

  // The rotated refresh_token must reach storage: the upstream invalidated the
  // previous one when it issued this one, so a write that does not land leaves
  // the row holding a dead credential that no later request can distinguish
  // from a revoked one. Delegate the write to the provider-owned helper so the
  // control plane and data plane share one rotation path.
  const persistRefreshTokenRotation = async (newRefreshToken: string): Promise<void> => {
    await persistCodexRefreshTokenRotation(record.id, account.chatgptAccountId, newRefreshToken);
  };

  try {
    await ensureCodexAccessToken(record.id, account.chatgptAccountId,
      refreshToken => mintCodexAccessToken(refreshToken, fetcher, persistRefreshTokenRotation),
      true);
  } catch (err) {
    if (err instanceof CodexOAuthSessionTerminatedError) {
      // Terminal flip delegates to the provider-owned helper: clear the cached
      // access token, mark the account refresh_failed so the dashboard renders
      // the red badge and prompts a re-import.
      await persistCodexRefreshFailure(record.id, account.chatgptAccountId, err.upstreamMessage);
      return c.json({ error: `Codex refresh failed: ${err.upstreamMessage}. Re-run OAuth exchange to recover.` }, 400);
    }
    return c.json({ error: errorMessage(err) }, 502);
  }

  const updated = await getRepo().upstreams.getById(record.id);
  if (!updated) return c.json({ error: 'Upstream not found' }, 404);
  return c.json({ patch: { state: updated.state } });
};
