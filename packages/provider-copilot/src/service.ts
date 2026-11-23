import { copilotIdentityHeaders, exchangeCopilotToken, isCopilotTokenFetchError, retryCopilotTokenFetch } from './auth.ts';
import { assertCopilotUpstreamRecord, type CopilotUpstreamFacts } from './config.ts';
import { fetchCopilotModels } from './fetch-models.ts';
import { emptyKnownModels, mergeKnownModels, projectKnownModels } from './known-models.ts';
import { fetchCopilotUsage, parseCopilotQuotaHeaders, projectCopilotSeat, projectCopilotUsageResponse, putCopilotQuota, putCopilotSeat, type CopilotUsageResponse } from './quota.ts';
import { readCopilotUpstreamState, type CopilotTokenEntry, type CopilotUpstreamState } from './state.ts';
import type { CopilotRawModel } from './types.ts';
import { Bytes, secret, snapshotError, type ErrorSnapshot, type Secret } from '@floway-dev/pipeline';
import { getProviderRepo, isUpstreamTransportError, runScheduledUsageRefresh, wrapSensitiveHeaderEntries, type Fetcher, type HeaderEntry, type ProviderScheduledOptions, type ProviderServices, type UpstreamRecord } from '@floway-dev/provider';

type AccessDecision =
  | { readonly kind: 'active'; readonly baseUrl: string; readonly token: Secret<string> }
  | {
    readonly kind: 'error';
    readonly source: 'upstream';
    readonly status: number;
    readonly headers: readonly HeaderEntry[];
    readonly body: Bytes;
    readonly transportError?: ErrorSnapshot;
  };

type QuotaPersistence = { readonly persisted: true } | { readonly persisted: false; readonly error: ErrorSnapshot };

export interface CopilotService {
  readonly access: (upstream: CopilotUpstreamFacts, fetcher: Fetcher, signal: AbortSignal) => Promise<AccessDecision>;
  readonly saveQuota: (upstreamId: string, headers: readonly HeaderEntry[]) => Promise<QuotaPersistence>;
}

export type CopilotServices = ProviderServices & { readonly copilot: CopilotService };

const IN_PROCESS_TTL_MS = 60_000;

const isTokenValid = ({ token, expiresAt }: CopilotTokenEntry, now: number): boolean =>
  token.length > 0 && expiresAt > Math.floor(now / 1000) + 60;

const newCopilotService = () => {
  // The persisted entry is shared across isolates. The process cache skips a
  // state read for closely spaced requests in the same isolate.
  const tokenCache = new Map<string, { entry: CopilotTokenEntry; cachedAt: number }>();

  const ensureToken = async ({ id, config }: CopilotUpstreamFacts, fetcher: Fetcher, signal?: AbortSignal): Promise<CopilotTokenEntry> => {
    const now = Date.now();
    const cached = tokenCache.get(id);
    if (cached && isTokenValid(cached.entry, now) && now - cached.cachedAt < IN_PROCESS_TTL_MS) return cached.entry;

    const fresh = await getProviderRepo().upstreams.getById(id);
    if (!fresh) throw new Error(`Copilot upstream ${id} disappeared mid-token-refresh`);
    const { copilotToken: persisted } = readCopilotUpstreamState(fresh.state);
    if (persisted && isTokenValid(persisted, now)) {
      tokenCache.set(id, { entry: persisted, cachedAt: now });
      return persisted;
    }

    const entry = await retryCopilotTokenFetch(
      () => exchangeCopilotToken(config.githubHost, config.githubToken.reveal(), fetcher, signal),
      signal,
    );
    tokenCache.set(id, { entry, cachedAt: Date.now() });
    // A write failure costs the next cold isolate a token exchange. This
    // isolate can already serve the live call with its cached token.
    try {
      await getProviderRepo().upstreams.saveState(id, current => ({
        ...readCopilotUpstreamState(current),
        copilotToken: entry,
      } satisfies CopilotUpstreamState));
    } catch (error) {
      console.warn(`Failed to persist Copilot token for ${id}:`, error);
    }
    return entry;
  };

  const access: CopilotService['access'] = async (upstream, fetcher, signal) => {
    try {
      const { baseUrl, token } = await ensureToken(upstream, fetcher, signal);
      return { kind: 'active', baseUrl, token: secret(token) };
    } catch (error) {
      if (signal.aborted) throw error;
      if (isCopilotTokenFetchError(error)) {
        return { kind: 'error', source: 'upstream', status: error.status, headers: wrapSensitiveHeaderEntries(error.headers), body: Bytes.fromUtf8(error.body) };
      }
      if (isUpstreamTransportError(error)) {
        return { kind: 'error', source: 'upstream', status: 502, headers: [], body: Bytes.empty, transportError: snapshotError(error) };
      }
      throw error;
    }
  };

  const saveQuota: CopilotService['saveQuota'] = async (upstreamId, headers) => {
    let quota;
    try {
      const wireHeaders = new Headers();
      for (const [name, value] of headers) wireHeaders.append(name, typeof value === 'string' ? value : value.reveal());
      quota = parseCopilotQuotaHeaders(wireHeaders, new Date());
    } catch (error) {
      console.warn(`Failed to parse Copilot quota snapshot for ${upstreamId}:`, error);
      return { persisted: false, error: snapshotError(error) };
    }
    if (quota !== null) {
      try {
        await putCopilotQuota(upstreamId, quota);
      } catch (error) {
        console.warn(`Failed to persist Copilot quota snapshot for ${upstreamId}:`, error);
        return { persisted: false, error: snapshotError(error) };
      }
    }
    return { persisted: true };
  };

  const fetchModels = (upstream: CopilotUpstreamFacts, fetcher: Fetcher) => fetchCopilotModels(async () => {
    let entry: CopilotTokenEntry;
    try {
      entry = await ensureToken(upstream, fetcher);
    } catch (error) {
      if (!isCopilotTokenFetchError(error)) throw error;
      const response = new Response(error.body, { status: error.status, headers: error.headers });
      void saveQuota(upstream.id, wrapSensitiveHeaderEntries(response.headers));
      return response;
    }
    const headers = new Headers(copilotIdentityHeaders().map(([name, value]) => [name, value]));
    headers.set('authorization', `Bearer ${entry.token}`);
    // https://github.com/caozhiyuan/copilot-api/blob/dc3d4aaf249d534bc66d5f1cb221ac29489b9753/src/lib/api-config.ts
    headers.set('openai-intent', 'model-access');
    headers.set('x-interaction-type', 'model-access');
    const response = await fetcher(`${entry.baseUrl}/models`, { method: 'GET', headers });
    void saveQuota(upstream.id, wrapSensitiveHeaderEntries(response.headers));
    return response;
  });

  const getProvidedModels = async (upstream: CopilotUpstreamFacts, fetcher: Fetcher): Promise<CopilotRawModel[]> => {
    const fresh = await getProviderRepo().upstreams.getById(upstream.id);
    if (!fresh) throw new Error(`Copilot upstream ${upstream.id} disappeared during catalog refresh`);
    const known = readCopilotUpstreamState(fresh.state).knownModels ?? emptyKnownModels();
    const response = await fetchModels(upstream, fetcher);
    const now = Date.now();
    try {
      await getProviderRepo().upstreams.saveState(upstream.id, current => {
        const state = readCopilotUpstreamState(current);
        return { ...state, knownModels: mergeKnownModels(state.knownModels ?? emptyKnownModels(), response, now) } satisfies CopilotUpstreamState;
      });
    } catch (error) {
      console.warn(`Failed to persist Copilot known-models for ${upstream.id}:`, error);
    }
    return projectKnownModels(mergeKnownModels(known, response, now), now);
  };

  const runScheduledTask = async (record: UpstreamRecord, options: ProviderScheduledOptions): Promise<void> => {
    const snapshot = readCopilotUpstreamState(record.state).quotaSnapshot;
    await runScheduledUsageRefresh(record, options, snapshot?.fetchedAt ?? null, async (fresh, fetcher) => {
      const { config } = assertCopilotUpstreamRecord(fresh);
      const response = await fetchCopilotUsage(config.githubHost, config.githubToken, fetcher);
      if (!response.ok) throw new Error(`Copilot usage returned ${response.status}: ${(await response.text()).slice(0, 256)}`);
      const body = await response.json() as CopilotUsageResponse;
      const now = new Date();
      const quota = projectCopilotUsageResponse(body, now);
      const seat = projectCopilotSeat(body, now);
      if (quota !== null) await putCopilotQuota(fresh.id, quota);
      if (seat !== null) await putCopilotSeat(fresh.id, seat);
    });
  };

  return { access, saveQuota, fetchModels, getProvidedModels, runScheduledTask, clearTokenCache: () => tokenCache.clear() };
};

export const createCopilotService = (): CopilotService => newCopilotService();
export const defaultCopilotService = newCopilotService();
export const clearInProcessCopilotTokenCache = (): void => defaultCopilotService.clearTokenCache();
