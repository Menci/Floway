import pRetry from 'p-retry';

import { githubHeaders, isCopilotTokenFetchTerminalStatus } from './auth.ts';
import { readCopilotAuth, type CopilotAuth } from './config.ts';
import { githubApiOrigin } from './github-host.ts';
import { parseCopilotQuotaHeaders, putCopilotQuotaAtVersion } from './quota.ts';
import { readCopilotUpstreamState, type CopilotTokenEntry } from './state.ts';
import { filterHeaders, isCausedBy, sendHttpRequest, setHeader, type Fetcher, type HttpHeaders, type HttpResponseSource, type HttpStreamError } from '@floway-dev/http';
import { secret, type Result, type Secret } from '@floway-dev/pipeline';
import { compressBytesToWebp } from '@floway-dev/platform';
import { isJsonObject } from '@floway-dev/protocols/common';
import { getUpstreamRuntimeRepo, type UpstreamHttpServices } from '@floway-dev/upstream';

export interface CopilotCredentials {
  baseUrl: string;
  token: Secret<string>;
}

type CredentialFailure =
  | { kind: 'http'; response: HttpResponseSource }
  | { kind: 'io'; error: HttpStreamError };

interface CopilotQuotaTarget {
  readonly id: string;
  readonly version: number;
}

type CredentialResolution = Result<CopilotCredentials, CredentialFailure> & {
  readonly quotaTarget: CopilotQuotaTarget | null;
};

export interface CopilotService {
  credentials(
    auth: CopilotAuth,
    fetcher: Fetcher,
    signal: AbortSignal,
    warn: (message: string, cause: unknown) => void,
  ): Promise<CredentialResolution>;
  observeQuota(target: CopilotQuotaTarget, headers: HttpHeaders): Promise<void>;
  compressImage: typeof compressBytesToWebp;
}

export interface CopilotServices extends UpstreamHttpServices {
  readonly copilot: CopilotService;
}

const TOKEN_BODY_BYTES = 256 * 1024;
const TOKEN_RETRIES = 3;
const QUOTA_HEADER_PREFIX = 'x-quota-snapshot-';

export const hasCopilotQuotaHeaders = (headers: HttpHeaders): boolean =>
  headers.some(([name]) => name.toLowerCase().startsWith(QUOTA_HEADER_PREFIX));

class TokenExchangeFailure extends Error {
  constructor(readonly failure: CredentialFailure) {
    super(failure.kind === 'http' ? `Copilot token exchange returned HTTP ${failure.response.status}` : 'Copilot token exchange failed',
      failure.kind === 'io' ? { cause: failure.error.cause } : undefined);
  }
}

const retryable = (error: unknown): error is TokenExchangeFailure =>
  error instanceof TokenExchangeFailure && (error.failure.kind === 'http'
    ? !isCopilotTokenFetchTerminalStatus(error.failure.response.status)
    : error.failure.error.kind !== 'abort');

const parseToken = (body: unknown): CopilotTokenEntry => {
  if (!isJsonObject(body) || typeof body.token !== 'string' || body.token === ''
    || typeof body.expires_at !== 'number' || !Number.isFinite(body.expires_at)
    || !isJsonObject(body.endpoints) || typeof body.endpoints.api !== 'string' || body.endpoints.api === '') {
    throw new TypeError('Invalid Copilot token exchange response');
  }
  return { token: body.token, expiresAt: body.expires_at, baseUrl: body.endpoints.api };
};

const readToken = async (response: HttpResponseSource): Promise<CopilotTokenEntry> => {
  const { body } = response;
  const decoder = new TextDecoder();
  let size = 0;
  let json = '';
  if (body !== null) {
    for await (const item of body) {
      if (!item.ok) throw new TokenExchangeFailure({ kind: 'io', error: item.error });
      size += item.value.byteLength;
      if (size > TOKEN_BODY_BYTES) throw new RangeError(`Copilot token response exceeds ${TOKEN_BODY_BYTES} bytes`);
      json += decoder.decode(item.value, { stream: true });
    }
  }
  return parseToken(JSON.parse(json + decoder.decode()));
};

const resolveToken = async (
  githubHost: string,
  githubToken: string,
  fetcher: Fetcher,
  signal: AbortSignal,
  warn: (message: string, cause: unknown) => void,
): Promise<Result<CopilotTokenEntry, CredentialFailure>> => {
  // https://github.com/caozhiyuan/copilot-api/blob/b16e01909e747b5ad49ce38137a6c1453e0052a6/src/lib/api-config.ts
  const url = `${githubApiOrigin(githubHost)}/copilot_internal/v2/token`;
  const identities = Object.entries(githubHeaders(githubToken));
  const headers = setHeader(identities, 'authorization', secret(githubToken).map(value => `token ${value}`));
  let terminal: { cause: unknown } | undefined;
  let pending: TokenExchangeFailure | undefined;
  try {
    const value = await pRetry(async attempt => {
      pending = undefined;
      try {
        const sent = await sendHttpRequest(fetcher, { url, method: 'GET', headers, body: null }, signal);
        if (!sent.ok) throw new TokenExchangeFailure({ kind: 'io', error: sent.error });
        const response = sent.value;
        if (response.status < 200 || response.status >= 300) {
          throw new TokenExchangeFailure({ kind: 'http', response });
        }
        return await readToken(response);
      } catch (cause) {
        if (retryable(cause) && attempt <= TOKEN_RETRIES) pending = cause;
        else terminal = { cause };
        throw cause;
      }
    }, {
      retries: TOKEN_RETRIES,
      factor: 2,
      minTimeout: 1000,
      signal,
      async shouldRetry({ error }) {
        if (!retryable(error)) return false;
        pending = undefined;
        if (error.failure.kind === 'http') await error.failure.response.body?.return();
        return true;
      },
      onFailedAttempt: ({ error, attemptNumber, retryDelay }) => {
        if (retryDelay > 0 && retryable(error) && !signal.aborted) {
          warn(`Retrying Copilot token exchange after ${retryDelay}ms (attempt ${attemptNumber})`, error);
        }
      },
    });
    return { ok: true, value };
  } catch (cause) {
    const error = terminal === undefined ? cause : terminal.cause;
    if (error instanceof TokenExchangeFailure) return { ok: false, error: error.failure };
    if (pending?.failure.kind === 'http') await pending.failure.response.body?.return();
    if (terminal === undefined && isCausedBy(error, signal.reason)) {
      return { ok: false, error: { kind: 'io', error: { kind: 'abort', cause: error } } };
    }
    throw error;
  }
};

const toCredentials = ({ baseUrl, token }: CopilotTokenEntry): CopilotCredentials => ({ baseUrl, token: secret(token) });

const credentials: CopilotService['credentials'] = async (auth, fetcher, signal, warn) => {
  const { id, githubHost, githubToken } = auth;
  const { upstreams } = getUpstreamRuntimeRepo();
  const fresh = await upstreams.getById(id);
  if (fresh === null) throw new Error(`Copilot upstream ${id} disappeared during token exchange`);
  const liveAuth = fresh.kind === 'copilot' ? readCopilotAuth(fresh) : null;
  const compatible = liveAuth?.githubHost === githubHost && liveAuth.githubToken === githubToken;
  const quotaTarget = compatible ? { id, version: fresh.version } : null;
  if (quotaTarget !== null) {
    const { copilotToken } = readCopilotUpstreamState(fresh.state);
    if (copilotToken !== null && copilotToken.expiresAt > Math.floor(Date.now() / 1000) + 60) {
      return { ok: true, value: toCredentials(copilotToken), quotaTarget };
    }
  }

  const exchange = await resolveToken(githubHost, githubToken, fetcher, signal, warn);
  if (!exchange.ok) return { ...exchange, quotaTarget };
  const entry = exchange.value;
  if (quotaTarget !== null) {
    try {
      await upstreams.saveState(id, (current, version) => version === quotaTarget.version
        ? { ...readCopilotUpstreamState(current), copilotToken: entry }
        : current);
    } catch (error) {
      warn(`Failed to persist Copilot token for ${id}`, error);
    }
  }
  return { ok: true, value: toCredentials(entry), quotaTarget };
};

const observeQuota: CopilotService['observeQuota'] = async ({ id, version }, headers) => {
  const quota = new Headers();
  for (const [name, value] of filterHeaders(headers, name => name.startsWith(QUOTA_HEADER_PREFIX))) {
    if (typeof value !== 'string') throw new TypeError(`Copilot response header ${name} must be plain text`);
    quota.append(name, value);
  }
  const snapshot = parseCopilotQuotaHeaders(quota, new Date());
  if (snapshot !== null) await putCopilotQuotaAtVersion(id, snapshot, version);
};

export const createCopilotServices = (http: UpstreamHttpServices): CopilotServices => ({
  ...http,
  copilot: { credentials, observeQuota, compressImage: compressBytesToWebp },
});
