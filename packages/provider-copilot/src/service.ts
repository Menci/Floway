import { createCopilotCredentials, isCopilotTokenFetchError } from './auth.ts';
import { projectCopilotModels, rawModelSupportsEndpoint } from './catalog.ts';
import { assertCopilotUpstreamRecord, type CopilotUpstreamConfig } from './config.ts';
import { fetchCopilotModels } from './fetch-models.ts';
import { normalizeGitHubHost } from './github-host.ts';
import { emptyKnownModels, mergeKnownModels, projectKnownModels, type CopilotKnownModels } from './known-models.ts';
import { copilotModelSupportsFastVariant, resolveCopilotRawModel, type ModelSelectionHints } from './model-selection.ts';
import { copilotVariantIndex } from './model-variants.ts';
import { parseCopilotQuotaHeaders, putCopilotQuota } from './quota.ts';
import { readCopilotUpstreamState, type CopilotUpstreamState } from './state.ts';
import { materializeHeaders, responseHeaderEntries, type HttpHeaders, type HttpResponseFact, type HttpStreamError } from '@floway-dev/http';
import { Secret, type Result } from '@floway-dev/pipeline';
import { compressBytesToWebp } from '@floway-dev/platform';
import type { ModelEndpointKey } from '@floway-dev/protocols/common';
import { getProviderRepo, type ProviderModel, type ProviderServices, type ProviderUpstream, type UpstreamRecord } from '@floway-dev/provider';

type CopilotModelSelection = { readonly kind: 'model'; readonly id: string } | { readonly kind: 'unsupportedFast' } | Extract<CopilotCredentialFailure, { kind: 'local' }>;
export type CopilotCredentials = { readonly baseUrl: string; readonly token: Secret<string> };
export type CopilotCredentialFailure =
  | { readonly kind: 'response'; readonly http: Omit<HttpResponseFact, 'body'>; readonly body: string }
  | { readonly kind: 'transport'; readonly error: HttpStreamError }
  | { readonly kind: 'local'; readonly message: string }
  | { readonly kind: 'invalid-response'; readonly http: Omit<HttpResponseFact, 'body'>; readonly message: string };
type CopilotFetcher = ReturnType<ProviderServices['fetcher']>;

export interface CopilotService {
  readonly credentials: (
    upstream: ProviderUpstream,
    fetcher: CopilotFetcher,
  ) => Promise<Result<CopilotCredentials, CopilotCredentialFailure>>;
  readonly identityHeaders: () => HttpHeaders;
  readonly compressImage: typeof compressBytesToWebp;
  readonly selectModel: (
    upstreamId: string,
    upstreamModelId: string,
    endpoint: ModelEndpointKey,
    hints: ModelSelectionHints,
  ) => Promise<CopilotModelSelection>;
  readonly observeQuota: (upstreamId: string, headers: HttpHeaders) => Promise<Result<void, unknown>>;
  readonly refreshCatalog: (record: UpstreamRecord, fetcher: CopilotFetcher) => Promise<ProviderModel[]>;
  readonly clearTokens: () => void;
}

export interface CopilotServices extends ProviderServices {
  readonly copilot: CopilotService;
}

const authConfig = (upstream: ProviderUpstream): Pick<CopilotUpstreamConfig, 'githubHost' | 'githubToken'> => {
  if (upstream.kind !== 'copilot' || typeof upstream.config !== 'object' || upstream.config === null) {
    throw new TypeError(`Expected Copilot upstream config for ${upstream.id}`);
  }
  const { githubHost, githubToken } = upstream.config as Record<string, unknown>;
  if (typeof githubHost !== 'string' || !(githubToken instanceof Secret)) {
    throw new TypeError(`Malformed GitHub credentials for Copilot upstream ${upstream.id}`);
  }
  return { githubHost: normalizeGitHubHost(githubHost), githubToken: githubToken.reveal() };
};

const readStoredModels = async (id: string): Promise<CopilotKnownModels | null> => {
  const fresh = await getProviderRepo().upstreams.getById(id);
  if (fresh === null) return null;
  return readCopilotUpstreamState(fresh.state).knownModels ?? emptyKnownModels();
};

export const createCopilotService = (): CopilotService => {
  const auth = createCopilotCredentials();
  const catalogs = new Map<string, { readonly models: CopilotKnownModels; readonly checkedAt: number }>();

  const credentials: CopilotService['credentials'] = async (upstream, fetcher) => {
    const { githubHost, githubToken } = authConfig(upstream);
    const token = await auth.getCopilotToken(upstream.id, githubHost, githubToken, fetcher);
    if (!token.ok) {
      const { error } = token;
      if (isCopilotTokenFetchError(error)) {
        const { response, body } = error;
        const http = { status: response.status, statusText: response.statusText, headers: responseHeaderEntries(response) };
        return { ok: false, error: { kind: 'response', http, body } };
      }
      return { ok: false, error };
    }
    return { ok: true, value: { baseUrl: token.value.baseUrl, token: Secret.from(token.value.token) } };
  };

  const modelsFor = async (id: string): Promise<CopilotKnownModels | null> => {
    const now = Date.now();
    const cached = catalogs.get(id);
    if (cached && now - cached.checkedAt < 60_000) return cached.models;
    const stored = await readStoredModels(id);
    if (stored === null) return null;
    const latest = catalogs.get(id);
    const models = latest && latest.models.fetchedAt > stored.fetchedAt ? latest.models : stored;
    catalogs.set(id, { models, checkedAt: now });
    return models;
  };

  const selectModel: CopilotService['selectModel'] = async (upstreamId, upstreamModelId, endpoint, hints) => {
    const models = await modelsFor(upstreamId);
    if (models === null) return { kind: 'local', message: `Copilot upstream ${upstreamId} disappeared while reading its catalog` };
    const catalog = projectKnownModels(models, Date.now());
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
    if (known === null) throw new Error(`Copilot upstream ${copilot.id} disappeared while reading its catalog`);
    const response = await fetchCopilotModels({
      id: copilot.id,
      githubHost: copilot.config.githubHost,
      githubToken: copilot.config.githubToken,
    }, fetcher, auth);
    const now = Date.now();
    const latest = catalogs.get(copilot.id)?.models;
    const models = mergeKnownModels(latest && latest.fetchedAt > known.fetchedAt ? latest : known, response, now);
    catalogs.set(copilot.id, { models, checkedAt: now });
    const { upstreams } = getProviderRepo();
    try {
      await upstreams.saveState(copilot.id, current => {
        const state = readCopilotUpstreamState(current);
        return {
          ...state,
          knownModels: mergeKnownModels(state.knownModels ?? emptyKnownModels(), response, now),
        } satisfies CopilotUpstreamState;
      });
    } catch (error) {
      console.warn(`Failed to persist Copilot known-models for ${copilot.id}:`, error);
    }
    return projectCopilotModels(projectKnownModels(models, now), copilot.flagOverrides);
  };

  return {
    credentials,
    identityHeaders: () => auth.identityHeaders().map(([name, value]) => [name, value]),
    compressImage: compressBytesToWebp,
    selectModel,
    refreshCatalog,
    async observeQuota(upstreamId, headers) {
      const snapshot = parseCopilotQuotaHeaders(new Headers(materializeHeaders(headers)), new Date());
      if (!snapshot.ok) return snapshot;
      if (snapshot.value === null) return { ok: true, value: undefined };
      try {
        await putCopilotQuota(upstreamId, snapshot.value);
      } catch (error) {
        return { ok: false, error };
      }
      return { ok: true, value: undefined };
    },
    clearTokens: auth.clear,
  };
};

export const getCopilotProvidedModels = (
  service: CopilotService,
  record: UpstreamRecord,
  fetcher: CopilotFetcher,
): Promise<ProviderModel[]> => service.refreshCatalog(record, fetcher);
