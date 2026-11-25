import { copilotIdentityHeaders, resolveCopilotToken, type CopilotCredentialFailure, type CopilotWarning, type ObserveCopilotHeaders } from './auth.ts';
import { projectCopilotModels } from './catalog.ts';
import { assertCopilotUpstreamRecord, copilotUpstreamFact, type CopilotUpstream } from './config.ts';
import { fetchCopilotModels, responseForCatalog } from './fetch-models.ts';
import { emptyKnownModels, mergeKnownModels, projectKnownModels, type CopilotKnownModels } from './known-models.ts';
import { parseCopilotQuotaHeaders, putCopilotQuota } from './quota.ts';
import { readCopilotUpstreamState, type CopilotTokenEntry, type CopilotUpstreamState } from './state.ts';
import { filterHeaders, sendHttpRequest, setHeader, type HttpHeaders, type ProviderFetcher } from '@floway-dev/http';
import { Secret, type Result } from '@floway-dev/pipeline';
import { compressBytesToWebp } from '@floway-dev/platform';
import { getProviderRepo, type ProviderModel, type ProviderServices, type UpstreamRecord } from '@floway-dev/provider';

export interface CopilotCredentials {
  readonly baseUrl: string;
  readonly token: Secret<string>;
}

type WaitUntil = (task: Promise<unknown>) => void;

export interface CopilotService {
  credentials(upstream: CopilotUpstream, fetcher: ProviderFetcher, signal: AbortSignal, warn: CopilotWarning, observeHeaders: ObserveCopilotHeaders): Promise<Result<CopilotCredentials, CopilotCredentialFailure>>;
  identityHeaders(): HttpHeaders;
  compressImage: typeof compressBytesToWebp;
  refreshCatalog(record: UpstreamRecord, fetcher: ProviderFetcher, warn: CopilotWarning, waitUntil: WaitUntil): Promise<ProviderModel[]>;
  observeQuota(upstreamId: string, headers: HttpHeaders): Promise<void>;
  clearTokens(upstreamId: string): void;
}

export interface CopilotServices extends ProviderServices {
  readonly copilot: CopilotService;
}

interface TokenMemo {
  configVersion: number;
  entry: CopilotTokenEntry;
  credentials: CopilotCredentials;
}

const tokenValid = (token: CopilotTokenEntry): boolean => token.expiresAt > Math.floor(Date.now() / 1000) + 60;
const credentialsFor = ({ baseUrl, token }: CopilotTokenEntry): CopilotCredentials => ({
  baseUrl,
  token: Secret.from(token),
});

const QUOTA_HEADER_PREFIX = 'x-quota-snapshot-';
export const hasCopilotQuotaHeaders = (headers: HttpHeaders): boolean => headers.some(([name]) => name.toLowerCase().startsWith(QUOTA_HEADER_PREFIX));

const observeQuota: CopilotService['observeQuota'] = async (upstreamId, headers) => {
  const quota = new Headers();
  for (const [name, value] of filterHeaders(headers, name => name.startsWith(QUOTA_HEADER_PREFIX))) {
    if (typeof value !== 'string') throw new TypeError(`Copilot response header ${name} must be plain text`);
    quota.append(name, value);
  }
  const snapshot = parseCopilotQuotaHeaders(quota, new Date());
  if (snapshot !== null) await putCopilotQuota(upstreamId, snapshot);
};

export const createCopilotService = (): CopilotService => {
  const tokens = new Map<string, TokenMemo>();
  const catalogs = new Map<string, CopilotKnownModels>();
  let deviceId: string | undefined;

  const credentials: CopilotService['credentials'] = async (upstream, fetcher, signal, warn, observeHeaders) => {
    const { id } = upstream;
    const { upstreams } = getProviderRepo();
    const fresh = await upstreams.getById(id);
    if (fresh === null) throw new Error(`Copilot upstream ${id} disappeared during token exchange`);
    const { configVersion } = fresh;
    const { copilotToken } = readCopilotUpstreamState(fresh.state);
    const cached = tokens.get(id);

    if (copilotToken !== null && tokenValid(copilotToken)) {
      if (cached?.configVersion === configVersion && cached.entry.token === copilotToken.token && cached.entry.baseUrl === copilotToken.baseUrl) {
        return { ok: true, value: cached.credentials };
      }
      const value = credentialsFor(copilotToken);
      tokens.set(id, { configVersion, entry: copilotToken, credentials: value });
      return { ok: true, value };
    }

    // The exchanged PAT comes from the same atomic record read as the
    // version compared by saveState. A new mint becomes memo-eligible only
    // when it is read back as the record's persisted token.
    const exchange = await resolveCopilotToken(copilotUpstreamFact(fresh), fetcher, signal, warn, observeHeaders);
    if (!exchange.ok) return exchange;
    const entry = exchange.value;
    try {
      await upstreams.saveState(id, (current, version) => version === configVersion
        ? { ...readCopilotUpstreamState(current), copilotToken: entry } satisfies CopilotUpstreamState
        : current);
    } catch (error) {
      warn(`Failed to persist Copilot token for ${id}`, error);
    }
    return { ok: true, value: credentialsFor(entry) };
  };

  const identityHeaders = (): HttpHeaders => copilotIdentityHeaders(deviceId ??= crypto.randomUUID());

  return {
    credentials,
    identityHeaders,
    compressImage: compressBytesToWebp,
    async refreshCatalog(record, fetcher, warn, waitUntil) {
      const upstream = copilotUpstreamFact(record);
      const { id } = upstream;
      const { upstreams } = getProviderRepo();
      const fresh = await upstreams.getById(id);
      if (fresh === null) throw new Error(`Copilot upstream ${id} disappeared while reading its model catalog`);
      const stored = readCopilotUpstreamState(fresh.state).knownModels ?? emptyKnownModels();
      const cached = catalogs.get(id);
      const previous = cached !== undefined && cached.fetchedAt > stored.fetchedAt ? cached : stored;

      const observeHeaders: ObserveCopilotHeaders = headers => {
        if (!hasCopilotQuotaHeaders(headers)) return;
        waitUntil(observeQuota(id, headers).catch(error => {
          warn(`Failed to record Copilot quota for ${id}`, error);
        }));
      };
      const signal = new AbortController().signal;
      const response = await fetchCopilotModels(async () => {
        const result = await credentials(upstream, fetcher, signal, warn, observeHeaders);
        if (!result.ok) {
          const { error } = result;
          if (error.kind === 'io') throw error.error.cause;
          return responseForCatalog({ ...error.head, body: error.body });
        }
        const { baseUrl, token } = result.value;
        const headers = setHeader(identityHeaders(), 'authorization', token.map(value => `Bearer ${value}`));
        const adjusted = setHeader(setHeader(headers, 'openai-intent', 'model-access'), 'x-interaction-type', 'model-access');
        const sent = await sendHttpRequest(fetcher, { method: 'GET', url: `${baseUrl}/models`, headers: adjusted, body: null }, signal);
        if (!sent.ok) throw sent.error.cause;
        observeHeaders(sent.value.headers);
        return responseForCatalog(sent.value);
      });
      const now = Date.now();
      const latest = catalogs.get(id);
      const known = mergeKnownModels(latest !== undefined && latest.fetchedAt > previous.fetchedAt ? latest : previous, response, now);
      catalogs.set(id, known);
      try {
        await upstreams.saveState(id, current => {
          const state = readCopilotUpstreamState(current);
          return {
            ...state,
            knownModels: mergeKnownModels(state.knownModels ?? emptyKnownModels(), response, now),
          } satisfies CopilotUpstreamState;
        });
      } catch (error) {
        warn(`Failed to persist Copilot known models for ${id}`, error);
      }
      return projectCopilotModels(projectKnownModels(known, now), assertCopilotUpstreamRecord(record).flagOverrides);
    },
    observeQuota,
    clearTokens(upstreamId) {
      tokens.delete(upstreamId);
    },
  };
};

export const getCopilotProvidedModels = (
  service: CopilotService,
  record: UpstreamRecord,
  fetcher: ProviderFetcher,
  warn: CopilotWarning,
  waitUntil: WaitUntil,
): Promise<ProviderModel[]> => service.refreshCatalog(record, fetcher, warn, waitUntil);
