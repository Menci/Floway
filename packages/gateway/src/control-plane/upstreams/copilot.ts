import { resolveControlPlaneFetcher } from './proxy-resolution.ts';
import { nextUpstreamUpdatedAt, upstreamErrorMessage as errorMessage } from './shared.ts';
import type { CtxWithJson } from '../../middleware/zod-validator.ts';
import { getRepo } from '../../repo/index.ts';
import { getRuntimeLocation } from '../../runtime/runtime-info.ts';
import type { copilotOAuthDeviceLoginPollBody, copilotOAuthDeviceLoginStartBody, copilotQuotaBody } from '../schemas.ts';
import { isRecord } from '../shared/field-validators.ts';
import { warmModelsCache } from '../shared/warm-models-cache.ts';
import { type Fetcher, UpstreamGenerationMismatchError } from '@floway-dev/provider';
import {
  assertCopilotUpstreamRecord,
  clearInProcessCopilotTokenCache,
  emptyCopilotUpstreamState,
  exchangeCopilotToken,
  fetchCopilotUsage,
  fetchGitHubUser,
  normalizeGitHubHost,
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

const parseCopilotDraftConfig = (config: unknown): { config: Record<string, unknown>; githubHost: string } => {
  if (!isRecord(config) || typeof config.githubHost !== 'string') {
    throw new Error('Copilot config must include a GitHub host');
  }
  return { config, githubHost: normalizeGitHubHost(config.githubHost) };
};

export const copilotOAuthDeviceLoginStart = async (c: CtxWithJson<typeof copilotOAuthDeviceLoginStartBody>) => {
  const { record } = c.req.valid('json');
  if (record.kind !== 'copilot') return c.json({ error: 'Upstream is not a Copilot upstream' }, 400);
  if (record.id !== '') {
    const persisted = await getRepo().upstreams.getById(record.id);
    if (!persisted) return c.json({ error: 'Upstream not found' }, 404);
    if (persisted.kind !== 'copilot') return c.json({ error: 'Upstream is not a Copilot upstream' }, 400);
  }

  let githubHost: string;
  let fetcher: Fetcher;
  try {
    ({ githubHost } = parseCopilotDraftConfig(record.config));
    fetcher = await resolveControlPlaneFetcher({
      override: record.proxy_fallback_list,
      upstreamId: record.id || undefined,
      runtimeLocation: getRuntimeLocation(c.req.raw),
    });
  } catch (e: unknown) {
    return c.json({ error: errorMessage(e) }, 400);
  }

  try {
    const result = await startGitHubDeviceFlow(githubHost, fetcher);
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
  if (record.kind !== 'copilot') return c.json({ status: 'error' as const, error: 'Upstream is not a Copilot upstream' }, 400);
  const repo = getRepo().upstreams;
  const dbRecord = record.id === '' ? null : await repo.getById(record.id);
  if (record.id !== '' && dbRecord === null) return c.json({ status: 'error' as const, error: 'Upstream not found' }, 404);
  if (dbRecord !== null && dbRecord.kind !== 'copilot') {
    return c.json({ status: 'error' as const, error: 'Upstream is not a Copilot upstream' }, 400);
  }

  // Config-validation errors (e.g. unknown proxy id in the override) surface
  // as 400 — they belong to the caller, not to the upstream.
  let fetcher: Fetcher;
  let githubHost: string;
  try {
    ({ githubHost } = parseCopilotDraftConfig(record.config));
    fetcher = await resolveControlPlaneFetcher({
      override: record.proxy_fallback_list,
      upstreamId: record.id || undefined,
      runtimeLocation: getRuntimeLocation(c.req.raw),
    });
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
    const data = await pollGitHubDeviceFlow(githubHost, deviceCode, fetcher);

    if (data.error === 'authorization_pending') return c.json({ status: 'pending' as const });
    if (data.error === 'slow_down') return c.json({ status: 'slow_down' as const });
    if (data.error) return c.json({ status: 'error' as const, error: data.error_description ?? data.error }, 400);
    if (!data.access_token) return c.json({ status: 'error' as const, error: 'GitHub device flow response missing access_token' }, 502);

    // Validates the PAT + seeds a fresh Copilot access token so the data
    // plane and dashboard `endpoints.api` calls work immediately without
    // a follow-up exchange round trip.
    const user = await fetchGitHubUser(githubHost, data.access_token, fetcher);
    const tokenEntry = await exchangeCopilotToken(githubHost, data.access_token, fetcher);
    cred = { user, tokenEntry, accessToken: data.access_token };
  } catch (e: unknown) {
    return c.json({ status: 'error' as const, error: errorMessage(e) }, 502);
  }

  const configPatch: CopilotUpstreamConfig = { githubHost, githubToken: cred.accessToken, user: cred.user };

  // Return the fully-merged state slot instead of a partial `{ copilotToken }`
  // patch. Frontend `applyPatch` does whole-slot replacement on state, so a
  // partial slot would clobber any sibling field (e.g. draft.state.knownModels
  // hydrated by an earlier fetch). Edit state seeds the merge from the stored
  // record only while the GitHub identity is unchanged. Identity changes and
  // creates start from an empty slot, so the reply is uniformly a full slot
  // regardless of caller path.
  let nextState: CopilotUpstreamState;
  if (record.id !== '') {
    let next;
    try {
      next = await repo.replaceCredentials(record.id, 'copilot', {
        createdAt: dbRecord!.createdAt,
        config: dbRecord!.config,
      }, currentRecord => {
        const current = assertCopilotUpstreamRecord(currentRecord);
        const sameIdentity = current.config.githubHost === githubHost && current.config.user.id === cred.user.id;
        const state = sameIdentity ? readCopilotUpstreamState(current.state) : emptyCopilotUpstreamState();
        return {
          config: configPatch,
          state: { ...state, copilotToken: cred.tokenEntry },
          updatedAt: nextUpstreamUpdatedAt(currentRecord),
        };
      });
    } catch (error) {
      if (error instanceof UpstreamGenerationMismatchError) {
        return c.json({ status: 'error' as const, error: 'Upstream credentials changed while device login was completing. Retry the login.' }, 409);
      }
      throw error;
    }
    if (!next) {
      const replacement = await repo.getById(record.id);
      if (replacement !== null && replacement.kind !== 'copilot') {
        return c.json({ status: 'error' as const, error: 'Upstream is not a Copilot upstream' }, 400);
      }
      return c.json({ status: 'error' as const, error: 'Upstream not found' }, 404);
    }
    nextState = readCopilotUpstreamState(next.state);
    clearInProcessCopilotTokenCache(record.id);
    await warmModelsCache(next, c, { readBack: false });
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
  const { record } = c.req.valid('json');
  if (record.kind !== 'copilot') return c.json({ error: 'Upstream is not a Copilot upstream' }, 400);

  let configInput = record.config;
  let persistedConfig: CopilotUpstreamConfig | undefined;
  if (record.id !== '') {
    const persisted = await getRepo().upstreams.getById(record.id);
    if (!persisted) return c.json({ error: 'Upstream not found' }, 404);
    if (persisted.kind !== 'copilot') return c.json({ error: 'Upstream is not a Copilot upstream' }, 400);
    persistedConfig = assertCopilotUpstreamRecord(persisted).config;
    configInput = persistedConfig;
  }

  let githubHost: string;
  let githubToken: string;
  let fetcher: Fetcher;
  try {
    const parsed = parseCopilotDraftConfig(configInput);
    githubHost = parsed.githubHost;
    const { config } = parsed;
    if (typeof config.githubToken !== 'string' || config.githubToken === '') {
      return c.json({ error: 'Copilot upstream has no GitHub token' }, 400);
    }
    githubToken = config.githubToken;
    fetcher = await resolveControlPlaneFetcher({
      override: record.proxy_fallback_list,
      upstreamId: record.id || undefined,
      runtimeLocation: getRuntimeLocation(c.req.raw),
    });
  } catch (e: unknown) {
    return c.json({ error: errorMessage(e) }, 400);
  }

  let snapshot: ReturnType<typeof projectCopilotUsageResponse>;
  try {
    const resp = await fetchCopilotUsage(githubHost, githubToken, fetcher);

    if (!resp.ok) {
      const text = await resp.text();
      const status = resp.status === 401 || resp.status === 403 ? 502 : resp.status;
      return c.json({ error: `GitHub API error: ${resp.status} ${text}` }, status as 400 | 404 | 500 | 502);
    }

    snapshot = projectCopilotUsageResponse((await resp.json()) as CopilotUsageResponse, new Date());
  } catch (e: unknown) {
    return c.json({ error: errorMessage(e) }, 502);
  }

  // A body that reports no buckets is "nothing observed", so it neither
  // persists nor replaces what the dashboard is already showing. Storage sits
  // outside the upstream-error catch: a failed durable write is an internal
  // failure and must reach the gateway's top-level error boundary.
  if (snapshot !== null && record.id !== '') await putCopilotQuota(record.id, snapshot, persistedConfig);
  return c.json(snapshot);
};
