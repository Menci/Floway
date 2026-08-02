import type { Context } from 'hono';

import { resolveControlPlaneFetcher } from './proxy-resolution.ts';
import { upstreamErrorMessage as errorMessage } from './shared.ts';
import type { CtxWithJson } from '../../middleware/zod-validator.ts';
import { getRepo } from '../../repo/index.ts';
import { getRuntimeLocation } from '../../runtime/runtime-info.ts';
import type { copilotOAuthDeviceLoginPollBody, copilotQuotaBody } from '../schemas.ts';
import { isRecord } from '../shared/field-validators.ts';
import { warmModelsCache } from '../shared/warm-models-cache.ts';
import type { Fetcher, UpstreamRecord } from '@floway-dev/provider';
import {
  clearInProcessCopilotTokenCache,
  emptyCopilotUpstreamState,
  exchangeCopilotToken,
  fetchCopilotUsage,
  fetchGitHubUser,
  pollGitHubDeviceFlow,
  projectCopilotUsageResponse,
  putCopilotQuota,
  readCopilotUpstreamState,
  startGitHubDeviceFlow,
  type CopilotTokenEntry,
  type CopilotUpstreamConfig,
  type CopilotUpstreamState,
  type CopilotUpstreamUser,
  type CopilotUsageResponse,
} from '@floway-dev/provider-copilot';

export const copilotOAuthDeviceLoginStart = async (c: Context) => {
  try {
    const result = await startGitHubDeviceFlow();
    if (!result.ok) return c.json({ error: result.error }, 502);
    return c.json(result.data);
  } catch (e: unknown) {
    const msg = errorMessage(e);
    return c.json({ error: msg }, 502);
  }
};

// Unified device-login poll under the record-body action contract. The
// GitHub device flow is inherently stateless; this handler exchanges the
// device_code for a GitHub PAT + user info + Copilot access token, and
// returns them as a patch to merge into the caller's draft record. When
// the caller supplies a persisted `record.id`, the same patch is
// simultaneously applied to the stored record so the live data plane
// picks up the fresh credential immediately.
export const copilotOAuthDeviceLoginPoll = async (c: CtxWithJson<typeof copilotOAuthDeviceLoginPollBody>) => {
  const { record, deviceCode } = c.req.valid('json');

  // Config-validation errors (e.g. unknown proxy id in the override) surface
  // as 400 — they belong to the caller, not to the upstream.
  let fetcher: Fetcher;
  try {
    fetcher = await resolveControlPlaneFetcher({ override: record.proxy_fallback_list, runtimeLocation: getRuntimeLocation(c.req.raw) });
  } catch (err) {
    return c.json({ status: 'error' as const, error: errorMessage(err) }, 400);
  }

  // Upstream-facing calls (GitHub device poll + user lookup + Copilot token
  // exchange) can legitimately 502 the caller when GitHub / Copilot is
  // unhealthy. DB ops below run OUTSIDE this catch so that a repo `.save()`
  // or scheduler failure surfaces as a 500 with a stack, not as a
  // misleading "upstream error" 502.
  type UpstreamCred = { user: CopilotUpstreamUser; tokenEntry: CopilotTokenEntry; accessToken: string };
  let cred: UpstreamCred;
  try {
    const data = await pollGitHubDeviceFlow(deviceCode, fetcher);

    if (data.error === 'authorization_pending') return c.json({ status: 'pending' as const });
    if (data.error === 'slow_down') return c.json({ status: 'slow_down' as const });
    if (data.error) return c.json({ status: 'error' as const, error: data.error_description ?? data.error }, 400);
    if (!data.access_token) return c.json({ status: 'error' as const, error: 'Unknown response' }, 500);

    // Validates the PAT + seeds a fresh Copilot access token so the data
    // plane and dashboard `endpoints.api` calls work immediately without
    // a follow-up exchange round trip.
    const user = await fetchGitHubUser(data.access_token, fetcher);
    const tokenEntry = await exchangeCopilotToken(data.access_token, fetcher);
    cred = { user, tokenEntry, accessToken: data.access_token };
  } catch (e: unknown) {
    return c.json({ status: 'error' as const, error: errorMessage(e) }, 502);
  }

  const configPatch: CopilotUpstreamConfig = { githubToken: cred.accessToken, user: cred.user };

  // Return the fully-merged state slot instead of a partial `{ copilotToken }`
  // patch. Frontend `applyPatch` does whole-slot replacement on state, so a
  // partial slot would clobber any sibling field (e.g. draft.state.knownModels
  // hydrated by an earlier fetch). Edit state seeds the merge from the stored
  // record; create state seeds from an empty slot so the reply is uniformly a
  // full slot regardless of caller path.
  let nextState: CopilotUpstreamState;
  if (record.id !== '') {
    const dbRecord = await getRepo().upstreams.getById(record.id);
    if (!dbRecord) return c.json({ status: 'error' as const, error: 'Upstream not found' }, 404);
    if (dbRecord.kind !== 'copilot') return c.json({ status: 'error' as const, error: 'Upstream is not a Copilot upstream' }, 400);
    const prevState = readCopilotUpstreamState(dbRecord.state);
    nextState = { ...prevState, copilotToken: cred.tokenEntry };
    const next: UpstreamRecord = { ...dbRecord, config: configPatch, state: nextState, updatedAt: new Date().toISOString() };
    await getRepo().upstreams.save(next);
    clearInProcessCopilotTokenCache();
    await warmModelsCache(next, c);
  } else {
    nextState = { ...emptyCopilotUpstreamState(), copilotToken: cred.tokenEntry };
  }

  return c.json({
    status: 'complete' as const,
    user: cred.user,
    patch: {
      config: configPatch,
      state: nextState,
    },
  });
};

// Refresh GitHub Copilot quota for the draft's github token. The data plane
// already keeps `state.quotaSnapshot` current from the `x-quota-snapshot-*`
// headers on every upstream response, so this is the explicit path: it seeds an
// upstream that has not served a request yet (including one still in create
// state, where there is no row to persist to), and lets an operator force a
// read without generating traffic. The projected snapshot is written into the
// same slot the passive path fills, so both sources render identically and the
// newer observation always wins. Replying with `null` means the upstream
// reported no buckets at all; the dashboard then keeps showing the stored
// snapshot rather than blanking the card.
export const copilotQuota = async (c: CtxWithJson<typeof copilotQuotaBody>) => {
  try {
    const { record } = c.req.valid('json');
    if (record.kind !== 'copilot') return c.json({ error: 'Upstream is not a Copilot upstream' }, 400);
    const config = isRecord(record.config) ? record.config : null;
    const githubToken = config && typeof config.githubToken === 'string' ? config.githubToken : '';
    if (!githubToken) return c.json({ error: 'Copilot upstream has no GitHub token' }, 400);

    const fetcher = await resolveControlPlaneFetcher({ override: record.proxy_fallback_list, runtimeLocation: getRuntimeLocation(c.req.raw) });
    const resp = await fetchCopilotUsage(githubToken, fetcher);

    if (!resp.ok) {
      const text = await resp.text();
      const status = resp.status === 401 || resp.status === 403 ? 502 : resp.status;
      return c.json({ error: `GitHub API error: ${resp.status} ${text}` }, status as 400 | 404 | 500 | 502);
    }

    const snapshot = projectCopilotUsageResponse((await resp.json()) as CopilotUsageResponse, new Date());
    // A body that reports no buckets is "nothing observed", so it neither
    // persists nor replaces what the dashboard is already showing — the
    // caller falls back to the stored snapshot. The reading otherwise merges
    // into whatever state wins the row, and the catch is here only so a
    // storage failure does not fail the operator's request.
    if (snapshot !== null && record.id !== '') {
      await putCopilotQuota(record.id, snapshot).catch((err: unknown) => {
        console.warn(`Failed to persist Copilot quota snapshot for ${record.id}:`, err);
      });
    }
    return c.json(snapshot);
  } catch (e: unknown) {
    return c.json({ error: errorMessage(e) }, 502);
  }
};
