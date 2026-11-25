import { createCopilotCredentials, isCopilotTokenFetchError, type CopilotTokenFetchError } from './auth.ts';
import { projectCopilotModels, rawModelSupportsEndpoint } from './catalog.ts';
import { assertCopilotUpstreamRecord, type CopilotUpstreamConfig } from './config.ts';
import { fetchCopilotModels } from './fetch-models.ts';
import { normalizeGitHubHost } from './github-host.ts';
import { emptyKnownModels, mergeKnownModels, projectKnownModels, type CopilotKnownModels } from './known-models.ts';
import { copilotModelSupportsFastVariant, resolveCopilotRawModel, type ModelSelectionHints } from './model-selection.ts';
import { copilotVariantIndex } from './model-variants.ts';
import { parseCopilotQuotaHeaders, putCopilotQuota } from './quota.ts';
import { readCopilotUpstreamState, type CopilotUpstreamState } from './state.ts';
import { materializeHeaders, type HttpHeaders, type HttpStreamError } from '@floway-dev/http';
import { Secret, type Result } from '@floway-dev/pipeline';
import type { ModelEndpointKey } from '@floway-dev/protocols/common';
import { getProviderRepo, type Fetcher, type ProviderModel, type ProviderServices, type ProviderUpstream, type UpstreamRecord } from '@floway-dev/provider';

type CopilotModelSelection = { readonly kind: 'model'; readonly id: string } | { readonly kind: 'unsupportedFast' };
type CopilotCredentials = { readonly baseUrl: string; readonly token: Secret<string> };
type CopilotCredentialFailure = CopilotTokenFetchError | HttpStreamError;
type CopilotFetcher = ReturnType<ProviderServices['fetcher']>;

export interface CopilotService {
  readonly credentials: (
    upstream: ProviderUpstream,
    fetcher: CopilotFetcher,
    signal: AbortSignal,
  ) => Promise<Result<CopilotCredentials, CopilotCredentialFailure>>;
  readonly identityHeaders: () => HttpHeaders;
  readonly selectModel: (
    upstreamId: string,
    upstreamModelId: string,
    endpoint: ModelEndpointKey,
    hints: ModelSelectionHints,
  ) => Promise<CopilotModelSelection>;
  readonly observeQuota: (upstreamId: string, headers: HttpHeaders) => Promise<void>;
  readonly refreshCatalog: (record: UpstreamRecord, fetcher: Fetcher) => Promise<CopilotKnownModels>;
  readonly clearTokens: () => void;
}

export interface CopilotServices extends ProviderServices {
  readonly copilot: CopilotService;
}

class CopilotCredentialTransportError extends Error {
  constructor(readonly failure: HttpStreamError) {
    super('GitHub Copilot credential exchange failed', { cause: failure.cause });
  }
}

const authConfig = (upstream: ProviderUpstream): Pick<CopilotUpstreamConfig, 'githubHost' | 'githubToken'> => {
  if (upstream.kind !== 'copilot' || typeof upstream.config !== 'object' || upstream.config === null) {
    throw new TypeError(`Expected Copilot upstream config for ${upstream.id}`);
  }
  const { githubHost, githubToken } = upstream.config as Record<string, unknown>;
  if (typeof githubHost !== 'string' || (typeof githubToken !== 'string' && !(githubToken instanceof Secret))) {
    throw new TypeError(`Malformed GitHub credentials for Copilot upstream ${upstream.id}`);
  }
  return { githubHost: normalizeGitHubHost(githubHost), githubToken: typeof githubToken === 'string' ? githubToken : githubToken.reveal() };
};

const readStoredModels = async (id: string): Promise<CopilotKnownModels> => {
  const fresh = await getProviderRepo().upstreams.getById(id);
  if (fresh === null || fresh === undefined) throw new Error(`Copilot upstream ${id} disappeared while reading its catalog`);
  return readCopilotUpstreamState(fresh.state).knownModels ?? emptyKnownModels();
};

export const createCopilotService = (): CopilotService => {
  const auth = createCopilotCredentials();
  const catalogs = new Map<string, { readonly models: CopilotKnownModels; readonly checkedAt: number }>();

  const credentials: CopilotService['credentials'] = async (upstream, fetcher, signal) => {
    const { githubHost, githubToken } = authConfig(upstream);
    try {
      const { baseUrl, token } = await auth.getCopilotToken(upstream.id, githubHost, githubToken, async (url, init) => {
        const result = await fetcher(url, init);
        if (!result.ok) throw new CopilotCredentialTransportError(result.error);
        return result.value;
      }, signal);
      return { ok: true, value: { baseUrl, token: Secret.from(token) } };
    } catch (error) {
      if (isCopilotTokenFetchError(error)) return { ok: false, error };
      if (error instanceof CopilotCredentialTransportError) return { ok: false, error: error.failure };
      if (signal.aborted && error === signal.reason) return { ok: false, error: { kind: 'abort', cause: error } };
      throw error;
    }
  };

  const modelsFor = async (id: string): Promise<CopilotKnownModels> => {
    const now = Date.now();
    const cached = catalogs.get(id);
    if (cached && now - cached.checkedAt < 60_000) return cached.models;
    const stored = await readStoredModels(id);
    const latest = catalogs.get(id);
    const models = latest && latest.models.fetchedAt > stored.fetchedAt ? latest.models : stored;
    catalogs.set(id, { models, checkedAt: now });
    return models;
  };

  const selectModel: CopilotService['selectModel'] = async (upstreamId, upstreamModelId, endpoint, hints) => {
    const catalog = projectKnownModels(await modelsFor(upstreamId), Date.now());
    const family = copilotVariantIndex(catalog).families.get(upstreamModelId);
    if (!family) throw new Error(`Copilot catalog contains no model family for ${upstreamModelId} on ${upstreamId}`);
    if (endpoint === 'anthropicMessages' && hints.fast && !copilotModelSupportsFastVariant(family)) {
      return { kind: 'unsupportedFast' };
    }
    const candidates = family.filter(model => rawModelSupportsEndpoint(model, endpoint));
    if (candidates.length === 0) {
      throw new Error(`Copilot provider exposed ${endpoint} for ${upstreamModelId}, but no raw variant supports that endpoint`);
    }
    const model = resolveCopilotRawModel({ object: 'list', data: candidates }, upstreamModelId, hints) ?? candidates[0];
    return { kind: 'model', id: model.id };
  };

  const refreshCatalog: CopilotService['refreshCatalog'] = async (record, fetcher) => {
    const copilot = assertCopilotUpstreamRecord(record);
    const known = await modelsFor(copilot.id);
    const response = await fetchCopilotModels({
      id: copilot.id,
      githubHost: copilot.config.githubHost,
      githubToken: copilot.config.githubToken,
    }, fetcher, auth);
    const now = Date.now();
    const latest = catalogs.get(copilot.id)?.models;
    const models = mergeKnownModels(latest && latest.fetchedAt > known.fetchedAt ? latest : known, response, now);
    catalogs.set(copilot.id, { models, checkedAt: now });
    try {
      await getProviderRepo().upstreams.saveState(copilot.id, current => {
        const state = readCopilotUpstreamState(current);
        return {
          ...state,
          knownModels: mergeKnownModels(state.knownModels ?? emptyKnownModels(), response, now),
        } satisfies CopilotUpstreamState;
      });
    } catch (error) {
      console.warn(`Failed to persist Copilot known-models for ${copilot.id}:`, error);
    }
    return models;
  };

  return {
    credentials,
    identityHeaders: () => auth.identityHeaders().map(([name, value]) => [name, value]),
    selectModel,
    refreshCatalog,
    async observeQuota(upstreamId, headers) {
      const snapshot = parseCopilotQuotaHeaders(new Headers(materializeHeaders(headers)), new Date());
      if (snapshot !== null) await putCopilotQuota(upstreamId, snapshot);
    },
    clearTokens: auth.clear,
  };
};

export const getCopilotProvidedModels = async (
  service: CopilotService,
  record: UpstreamRecord,
  fetcher: Fetcher,
): Promise<ProviderModel[]> => {
  const known = await service.refreshCatalog(record, fetcher);
  return projectCopilotModels(projectKnownModels(known, Date.now()), record.flagOverrides);
};
