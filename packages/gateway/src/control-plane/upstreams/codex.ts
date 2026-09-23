import { resolveControlPlaneFetcher } from './proxy-resolution.ts';
import { upstreamErrorMessage as errorMessage } from './shared.ts';
import type { CtxWithJson } from '../../middleware/zod-validator.ts';
import { getRepo } from '../../repo/index.ts';
import { getRuntimeLocation } from '../../runtime/runtime-info.ts';
import type { codexImportExchangeBody, codexImportPreviewBody, codexOAuthAuthorizeUrlBody, codexOAuthRefreshBody, codexRateLimitResetConsumeBody, codexRateLimitResetCreditsBody } from '../schemas.ts';
import { warmModelsCache } from '../shared/warm-models-cache.ts';
import type { Fetcher, UpstreamRecord } from '@floway-dev/provider';
import {
  buildCodexAuthorizeUrl,
  CodexRateLimitResetRequestError,
  assertCodexUpstreamRecord,
  clearCodexQuota,
  consumeCodexRateLimitResetCredit,
  fetchCodexRateLimitResetCredits,
  invalidateCodexAccessToken,
  type CodexUpstreamConfig,
  type CodexUpstreamState,
  CodexAccessOnlyCredentialError,
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

class CodexActionError extends Error {
  constructor(readonly status: 400 | 404 | 502, message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = 'CodexActionError';
  }
}

const ensureCodexControlPlaneAccessToken = async (opts: {
  accountId: string | null;
  fetcher: Fetcher;
  force?: boolean;
  upstreamId: string;
}): Promise<string> => {
  const persistRotation = (newRefreshToken: string): Promise<void> =>
    persistCodexRefreshTokenRotation(opts.upstreamId, opts.accountId, newRefreshToken);

  try {
    const access = await ensureCodexAccessToken(
      opts.upstreamId,
      opts.accountId,
      refreshToken => mintCodexAccessToken(refreshToken, opts.fetcher, persistRotation),
      opts.force,
    );
    return access.token;
  } catch (cause) {
    if (cause instanceof CodexOAuthSessionTerminatedError) {
      await persistCodexRefreshFailure(opts.upstreamId, opts.accountId, cause.upstreamMessage);
      throw new CodexActionError(400, `Codex refresh failed: ${cause.upstreamMessage}. Re-run OAuth exchange to recover.`, { cause });
    }
    throw new CodexActionError(502, errorMessage(cause), { cause });
  }
};

const codexActionAccess = async (opts: {
  record: { id: string; kind: string; proxy_fallback_list?: UpstreamRecord['proxyFallbackList'] };
  request: Request;
}): Promise<{ accessToken: string; accountId: string | null; fetcher: Fetcher }> => {
  if (opts.record.kind !== 'codex') throw new CodexActionError(400, 'Upstream is not a Codex upstream');
  if (opts.record.id === '') throw new CodexActionError(400, 'Codex reset credits require a persisted upstream');
  const stored = await getRepo().upstreams.getById(opts.record.id);
  if (!stored) throw new CodexActionError(404, 'Upstream not found');
  if (stored.kind !== 'codex') throw new CodexActionError(400, 'Upstream is not a Codex upstream');
  assertCodexUpstreamRecord(stored);
  assertCodexUpstreamState(stored.state);
  const identity = stored.config.accounts[0];
  const account = stored.state.accounts.find(entry => entry.chatgptAccountId === identity.chatgptAccountId);
  if (!account) throw new CodexActionError(400, 'Configured Codex account is missing from stored state');
  if (account.state !== 'active') {
    throw new CodexActionError(400, `Codex upstream is ${account.state}; re-run OAuth exchange to recover`);
  }

  let fetcher: Fetcher;
  try {
    fetcher = await resolveControlPlaneFetcher({
      override: opts.record.proxy_fallback_list,
      upstreamId: opts.record.id,
      runtimeLocation: getRuntimeLocation(opts.request),
    });
  } catch (cause) {
    throw new CodexActionError(400, errorMessage(cause), { cause });
  }

  const accessToken = await ensureCodexControlPlaneAccessToken({
    upstreamId: opts.record.id,
    accountId: identity.chatgptAccountId,
    fetcher,
  });
  return { accessToken, accountId: identity.chatgptAccountId, fetcher };
};

type CodexActionAccess = Awaited<ReturnType<typeof codexActionAccess>>;

const withCodexResetAccess = async <Result>(opts: {
  access: CodexActionAccess;
  operation: (accessToken: string) => Promise<Result>;
  upstreamId: string;
}): Promise<Result> => {
  try {
    return await opts.operation(opts.access.accessToken);
  } catch (error) {
    if (!(error instanceof CodexRateLimitResetRequestError) || error.status !== 401) throw error;
    // A definite 401 means the consume did not run, so retrying it with the
    // caller's same idempotency key is safe. Network failures remain ambiguous
    // and deliberately bypass this branch.
    const retained = await invalidateCodexAccessToken(opts.upstreamId, opts.access.accountId, opts.access.accessToken);
    opts.access.accessToken = retained?.token ?? await ensureCodexControlPlaneAccessToken({
      upstreamId: opts.upstreamId,
      accountId: opts.access.accountId,
      fetcher: opts.access.fetcher,
    });
    return await opts.operation(opts.access.accessToken);
  }
};

const actionFailure = (error: unknown): { status: 400 | 404 | 502; message: string } =>
  error instanceof CodexActionError
    ? { status: error.status, message: error.message }
    : { status: 502, message: errorMessage(error) };

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
    if (err instanceof CodexAccessOnlyCredentialError) {
      // An access-only credential has nothing to refresh from; surface the
      // provider's re-import instruction verbatim.
      return c.json({ error: err.message }, 400);
    }
    return c.json({ error: errorMessage(err) }, 502);
  }

  const updated = await getRepo().upstreams.getById(record.id);
  if (!updated) return c.json({ error: 'Upstream not found' }, 404);
  return c.json({ patch: { state: updated.state } });
};

export const codexRateLimitResetCredits = async (c: CtxWithJson<typeof codexRateLimitResetCreditsBody>) => {
  const { record } = c.req.valid('json');
  try {
    const access = await codexActionAccess({ record, request: c.req.raw });
    const resetCredits = await withCodexResetAccess({
      upstreamId: record.id,
      access,
      operation: accessToken => fetchCodexRateLimitResetCredits({
        accessToken,
        accountId: access.accountId,
        fetcher: access.fetcher,
        signal: c.req.raw.signal,
      }),
    });
    return c.json({ reset_credits: resetCredits });
  } catch (error) {
    const failure = actionFailure(error);
    return c.json({ error: failure.message }, failure.status);
  }
};

export const codexRateLimitResetConsume = async (c: CtxWithJson<typeof codexRateLimitResetConsumeBody>) => {
  const { record, credit_id: creditId, idempotency_key: idempotencyKey } = c.req.valid('json');
  let access: Awaited<ReturnType<typeof codexActionAccess>>;
  try {
    access = await codexActionAccess({ record, request: c.req.raw });
  } catch (error) {
    const failure = actionFailure(error);
    return c.json({ error: failure.message }, failure.status);
  }

  let outcome;
  try {
    outcome = await withCodexResetAccess({
      upstreamId: record.id,
      access,
      operation: accessToken => consumeCodexRateLimitResetCredit({
        accessToken,
        accountId: access.accountId,
        creditId,
        idempotencyKey,
        fetcher: access.fetcher,
        signal: c.req.raw.signal,
      }),
    });
  } catch (error) {
    return c.json({ error: errorMessage(error) }, 502);
  }

  // Once the upstream accepted the idempotent consume call, secondary refresh
  // failures must not turn the whole response into an error: that could prompt
  // a caller to mint another key and redeem twice. Report the outcome first,
  // then expose any stale-view warning beside the best available card list.
  const refreshErrors: string[] = [];
  let resetCredits = null;
  if (outcome.code === 'reset' || outcome.code === 'already_redeemed') {
    try {
      await clearCodexQuota(record.id, access.accountId);
    } catch (error) {
      refreshErrors.push(errorMessage(error));
    }
  }
  try {
    resetCredits = await withCodexResetAccess({
      upstreamId: record.id,
      access,
      operation: accessToken => fetchCodexRateLimitResetCredits({
        accessToken,
        accountId: access.accountId,
        fetcher: access.fetcher,
        signal: c.req.raw.signal,
      }),
    });
  } catch (error) {
    refreshErrors.push(errorMessage(error));
  }

  return c.json({
    outcome,
    reset_credits: resetCredits,
    refresh_error: refreshErrors.length === 0 ? null : refreshErrors.join('; '),
  });
};
