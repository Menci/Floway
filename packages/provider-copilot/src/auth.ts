import pRetry, { AbortError as RetryAbortError } from 'p-retry';

import { githubApiOrigin } from './github-host.ts';
import { readCopilotUpstreamState, type CopilotTokenEntry, type CopilotUpstreamState } from './state.ts';
import { dispatchUpstreamFetch, getProviderRepo as getRepo, isAbortError, type Fetcher } from '@floway-dev/provider';

// Version constants pinned to a known-good fingerprint that mirrors what a
// current VSCode Copilot Chat install sends. The Copilot Chat plugin version,
// the VSCode host version, and the Copilot data-plane api version are one
// coordinated set — they ship together in a real editor build and Copilot
// validates the combination, so they move together on every bump. We track a
// maintained reference implementation rather than fetching these at startup: a
// server-side gateway gains no realism from chasing the latest editor release,
// and a boot-time HTTP dependency is a needless failure mode. Sourced from
// caozhiyuan/copilot-api@b16e019 (COPILOT_VERSION, USER_AGENT, api version):
//   https://github.com/caozhiyuan/copilot-api/blob/b16e01909e747b5ad49ce38137a6c1453e0052a6/src/lib/api-config.ts#L148-L156
// and its VSCode host version fallback:
//   https://github.com/caozhiyuan/copilot-api/blob/b16e01909e747b5ad49ce38137a6c1453e0052a6/src/services/get-vscode-version.ts#L1
const COPILOT_VERSION = '0.52.0';
const VSCODE_VERSION = '1.124.2';
const EDITOR_VERSION = `vscode/${VSCODE_VERSION}`;
const EDITOR_PLUGIN_VERSION = `copilot-chat/${COPILOT_VERSION}`;
const USER_AGENT = `GitHubCopilotChat/${COPILOT_VERSION}`;
const COPILOT_API_VERSION = '2026-06-01';
const GITHUB_API_VERSION = '2025-04-01';

// User-agent VSCode Copilot Chat sends on its Claude Code SDK proxy path.
// Bump alongside COPILOT_VERSION when caozhiyuan/copilot-api upgrades it
// upstream.
export const CLAUDE_AGENT_USER_AGENT = 'vscode_claude_code/2.1.112 (external, sdk-ts, agent-sdk/0.2.112)';

// Stable per-process device id, like real VSCode generates once per install.
// Initialized lazily on first use because crypto APIs may be unavailable in
// module-global scope on some runtimes.
let editorDeviceId: string | null = null;
const getEditorDeviceId = (): string => (editorDeviceId ??= crypto.randomUUID());

// Statuses that indicate the GitHub→Copilot token exchange will not improve
// on retry. 403 = the GitHub token is unauthorized for Copilot; 429 = the
// upstream rate-limits the token endpoint, and waiting out the window inside
// our retry budget burns the dial deadline without changing the verdict. The
// HTTP-convention 5xx range falls through to the retry path because the
// selected GitHub API endpoint can return 500/502/503/504 transiently
// (caozhiyuan/copilot-api retries every refresh failure).
const isCopilotTokenFetchTerminalStatus = (status: number): boolean => status === 403 || status === 429;

// Two-level Copilot token cache: in-process (60s) memo keyed by upstream id,
// backed by per-upstream `state_json.copilotToken` for cross-isolate / cold-
// start sharing. The persisted entry survives a worker eviction; the in-
// process memo avoids a DB read on every request inside one isolate.
const IN_PROCESS_TTL_MS = 60_000;
const inProcessTokenCache = new Map<
  string,
  {
    entry: CopilotTokenEntry;
    cachedAt: number;
  }
>();

interface InFlightTokenRefresh {
  readonly controller: AbortController;
  readonly promise: Promise<CopilotTokenEntry>;
  waiters: number;
  settled: boolean;
}

const inFlightTokenRefreshes = new Map<string, InFlightTokenRefresh>();
let tokenCacheGeneration = 0;

const reusableTokenRefresh = (upstreamId: string): InFlightTokenRefresh | undefined => {
  const refresh = inFlightTokenRefreshes.get(upstreamId);
  if (!refresh) return undefined;
  if (!refresh.settled && !refresh.controller.signal.aborted) return refresh;
  inFlightTokenRefreshes.delete(upstreamId);
  return undefined;
};

export class CopilotTokenFetchError extends Error {
  constructor(readonly status: number, readonly body: string, readonly headers: Headers) {
    super(`Copilot token fetch failed: ${status} ${body}`);
    this.name = 'CopilotTokenFetchError';
  }
}

export const isCopilotTokenFetchError = (error: unknown): error is CopilotTokenFetchError => error instanceof CopilotTokenFetchError;

// Tests use this to drop process-local authentication state between cases —
// they run against a fresh DB per test so the persisted state needs no separate
// reset, and some tests deliberately want the next call to hydrate from
// state_json instead of minting a fresh token. Cancelling an unfinished shared
// refresh prevents it from writing into the next test's repository instance.
export function clearInProcessCopilotTokenCache(): void {
  tokenCacheGeneration += 1;
  inProcessTokenCache.clear();
  for (const refresh of inFlightTokenRefreshes.values()) {
    refresh.controller.abort(new DOMException('Copilot token cache cleared', 'AbortError'));
  }
  inFlightTokenRefreshes.clear();
}

class RetryableError extends Error {
  constructor(readonly originalError: unknown) {
    super(originalError instanceof Error ? originalError.message : String(originalError), { cause: originalError });
  }
}

class NonErrorAbort extends Error {
  constructor(readonly originalError: unknown) {
    super(String(originalError), { cause: originalError });
  }
}

const retryCopilotTokenFetch = async <T>(fn: () => Promise<T>, signal: AbortSignal | undefined): Promise<T> => {
  try {
    return await pRetry(async () => {
      try {
        return await fn();
      } catch (error) {
        if (isAbortError(error) || (isCopilotTokenFetchError(error) && isCopilotTokenFetchTerminalStatus(error.status))) {
          throw new RetryAbortError(error instanceof Error ? error : new NonErrorAbort(error));
        }

        // p-retry rejects non-network TypeErrors immediately and normalizes
        // non-Error rejections into terminal TypeErrors. The token exchange
        // previously retried every non-terminal value, so both shapes travel
        // through a retryable Error and are restored at the boundary.
        if (!(error instanceof Error) || error instanceof TypeError) throw new RetryableError(error);
        throw error;
      }
    }, {
      retries: 3,
      factor: 2,
      minTimeout: 1000,
      signal,
      onFailedAttempt: ({ error, attemptNumber, retryDelay }) => {
        if (retryDelay === 0) return;
        const cause = error instanceof RetryableError ? error.originalError : error;
        console.warn(`Retry ${attemptNumber}/3 after ${retryDelay}ms: ${cause instanceof Error ? cause.message : String(cause)}`);
      },
    });
  } catch (error) {
    if (error instanceof RetryableError) throw error.originalError;
    if (error instanceof NonErrorAbort) throw error.originalError;
    throw error;
  }
};

function isTokenValid(token: string | null, expiresAt: number): boolean {
  if (!token) return false;
  const now = Math.floor(Date.now() / 1000);
  return expiresAt > now + 60;
}

const awaitRefresh = async (
  refresh: InFlightTokenRefresh,
  signal: AbortSignal | undefined,
): Promise<CopilotTokenEntry> => {
  refresh.waiters += 1;
  try {
    if (!signal) return await refresh.promise;
    if (signal.aborted) throw signal.reason;

    return await new Promise<CopilotTokenEntry>((resolve, reject) => {
      const onAbort = () => reject(signal.reason);
      signal.addEventListener('abort', onAbort, { once: true });
      void refresh.promise.then(resolve, reject).finally(() => {
        signal.removeEventListener('abort', onAbort);
      });
    });
  } finally {
    refresh.waiters -= 1;
    if (!refresh.settled && refresh.waiters === 0) {
      refresh.controller.abort(signal?.reason ?? new DOMException('Copilot token refresh has no waiters', 'AbortError'));
    }
  }
};

const refreshCopilotToken = (
  upstreamId: string,
  githubHost: string,
  githubToken: string,
  fetcher: Fetcher,
): InFlightTokenRefresh => {
  const existing = reusableTokenRefresh(upstreamId);
  if (existing) return existing;

  const controller = new AbortController();
  const generation = tokenCacheGeneration;
  const promise = retryCopilotTokenFetch(async () => {
    const entry = await exchangeCopilotToken(githubHost, githubToken, fetcher, controller.signal);
    if (controller.signal.aborted) throw controller.signal.reason;
    inProcessTokenCache.set(upstreamId, { entry, cachedAt: Date.now() });
    // Best-effort: the caller is about to satisfy a live request with this
    // token, so a storage failure costs the next cold isolate one extra mint
    // rather than the request. Swallowing here also keeps such a failure out
    // of retryCopilotTokenFetch, which would otherwise answer it by minting
    // again.
    try {
      await getRepo().upstreams.saveState(upstreamId, current => {
        const state = readCopilotUpstreamState(current);
        if (generation !== tokenCacheGeneration) return state;
        return {
          ...state,
          copilotToken: entry,
        } satisfies CopilotUpstreamState;
      });
    } catch (err) {
      console.warn(`Failed to persist Copilot token for ${upstreamId}:`, err);
    }
    return entry;
  }, controller.signal);
  const refresh: InFlightTokenRefresh = { controller, promise, waiters: 0, settled: false };
  inFlightTokenRefreshes.set(upstreamId, refresh);
  // The lifecycle observer is attached before callers can join. Its catch owns
  // the rejection when every waiter has already cancelled.
  void promise.finally(() => {
    refresh.settled = true;
    if (inFlightTokenRefreshes.get(upstreamId) === refresh) {
      inFlightTokenRefreshes.delete(upstreamId);
    }
  }).catch(() => undefined);
  return refresh;
};

async function getCopilotToken(upstreamId: string, githubHost: string, githubToken: string, fetcher: Fetcher, signal: AbortSignal | undefined): Promise<CopilotTokenEntry> {
  if (signal?.aborted) throw signal.reason;
  const now = Date.now();
  const cached = inProcessTokenCache.get(upstreamId);
  if (cached && isTokenValid(cached.entry.token, cached.entry.expiresAt) && now - cached.cachedAt < IN_PROCESS_TTL_MS) {
    return cached.entry;
  }

  const activeRefresh = reusableTokenRefresh(upstreamId);
  if (activeRefresh) return await awaitRefresh(activeRefresh, signal);

  const fresh = await getRepo().upstreams.getById(upstreamId);
  if (!fresh) throw new Error(`Copilot upstream ${upstreamId} disappeared mid-token-refresh`);
  const state = readCopilotUpstreamState(fresh.state);
  const persisted = state.copilotToken;
  if (persisted && isTokenValid(persisted.token, persisted.expiresAt)) {
    inProcessTokenCache.set(upstreamId, { entry: persisted, cachedAt: now });
    return persisted;
  }

  // Routed through the upstream's Fetcher so deployments behind a network
  // egress restriction (e.g. GFW) keep refreshing tokens through the same
  // proxy chain that carries the data-plane traffic; without this, a working
  // Copilot proxy would still see periodic auth-refresh failures every
  // ~25 minutes per process. Concurrent misses share one exchange. Each caller
  // retains independent cancellation; the shared fetch is cancelled only after
  // its final waiter leaves.
  return await awaitRefresh(refreshCopilotToken(upstreamId, githubHost, githubToken, fetcher), signal);
}

// Pure exchange against /copilot_internal/v2/token — no caching, no
// persistence, no retry. Callers that want those wrap it (getCopilotToken
// adds all three; the control-plane import path calls it once to validate
// the PAT and seed initial state). Method is GET, not POST — POST returns
// 404 from this endpoint (matches VSCode Copilot Chat and caozhiyuan/copilot-
// api). `endpoints.api` is the per-tier data-plane host GitHub routes this
// PAT to — it travels with the token because they share a lifetime
// (vscode-copilot-chat 5863f5a7 domainServiceImpl.ts L55, refreshes on
// every onDidStoreUpdate; all four reference implementations agree).
export async function exchangeCopilotToken(githubHost: string, githubToken: string, fetcher: Fetcher, signal?: AbortSignal): Promise<CopilotTokenEntry> {
  const resp = await fetcher(`${githubApiOrigin(githubHost)}/copilot_internal/v2/token`, {
    method: 'GET',
    headers: githubHeaders(githubToken),
    signal,
  });

  if (!resp.ok) {
    const text = await resp.text();
    throw new CopilotTokenFetchError(resp.status, text, new Headers(resp.headers));
  }

  const data: unknown = await resp.json();
  if (typeof data !== 'object' || data === null || Array.isArray(data)) {
    throw new TypeError('Copilot token exchange response must be an object');
  }
  const fields = data as Record<string, unknown>;
  if (typeof fields.token !== 'string' || fields.token === '') {
    throw new TypeError('Copilot token exchange response missing token');
  }
  if (typeof fields.expires_at !== 'number' || !Number.isFinite(fields.expires_at)) {
    throw new TypeError('Copilot token exchange response missing finite expires_at');
  }
  const endpoints = fields.endpoints;
  const baseUrl = typeof endpoints === 'object' && endpoints !== null && !Array.isArray(endpoints)
    ? (endpoints as Record<string, unknown>).api
    : undefined;
  if (typeof baseUrl !== 'string' || baseUrl === '') {
    throw new Error('Copilot token exchange response missing endpoints.api');
  }

  return {
    token: fields.token,
    expiresAt: fields.expires_at,
    baseUrl,
  };
}

export interface CopilotFetchOptions {
  headers?: Headers;
  /** Per-request proxy-aware indirection. Used for both the data-plane
   *  request and the selected GitHub host's token exchange so a single
   *  fallback chain covers both paths under restricted egress. */
  fetcher: Fetcher;
  /** See UpstreamCallOptions.wrapUpstreamCall. Fires on the data-plane
   *  request only, after any token-exchange round trip. */
  wrapUpstreamCall: <T>(dispatch: () => Promise<T>) => Promise<T>;
}

export interface CopilotAuth {
  id: string;
  githubHost: string;
  githubToken: string;
}

export async function copilotAuthedFetch(path: string, init: RequestInit, auth: CopilotAuth, options: CopilotFetchOptions): Promise<Response> {
  const signal = init.signal ?? undefined;
  let ownedInit: RequestInit | undefined = init;
  // The token exchange is the only await before the data-plane dispatch. Keep
  // the body in an explicit owner and replace the generator parameter so the
  // final network wait cannot retain both copies after ownership transfers.
  init = { signal };
  const entry = await getCopilotToken(auth.id, auth.githubHost, auth.githubToken, options.fetcher, signal);

  // x-request-id and x-agent-task-id share a single per-call UUID, mirroring
  // VSCode Copilot Chat's "one id ties the request to its background task" pattern.
  const requestId = crypto.randomUUID();

  if (ownedInit === undefined) throw new Error('Copilot request ownership missing before dispatch');
  const headers = new Headers(ownedInit.headers);
  headers.set('Authorization', `Bearer ${entry.token}`);
  headers.set('Content-Type', 'application/json');
  headers.set('editor-version', EDITOR_VERSION);
  headers.set('editor-plugin-version', EDITOR_PLUGIN_VERSION);
  headers.set('editor-device-id', getEditorDeviceId());
  headers.set('user-agent', USER_AGENT);
  headers.set('x-github-api-version', COPILOT_API_VERSION);
  headers.set('x-vscode-user-agent-library-version', 'electron-fetch');
  headers.set('x-request-id', requestId);
  headers.set('x-agent-task-id', requestId);
  headers.set('copilot-integration-id', 'vscode-chat');
  headers.set('openai-intent', 'conversation-agent');
  headers.set('x-interaction-type', 'conversation-agent');

  // Provider-attached invocation headers (vision, initiator, anthropic-beta,
  // ...) flow through unchanged. The provider's boundary interceptors decide
  // which headers each upstream call needs; this layer only knows how to ship
  // them. Setting them last lets workaround interceptors override the static
  // VSCode identification block when a future workaround needs to.
  //
  // Convention: an empty-string value from an interceptor means "delete this
  // base header" — the interceptor wants Copilot to NOT see a default we'd
  // otherwise pin. An interceptor that wants to clear an arbitrary downstream
  // header value must do so by name through this sentinel; the layer does not
  // otherwise expose a per-header delete API.
  if (options.headers) {
    for (const [name, value] of options.headers) {
      if (value === '') headers.delete(name);
      else headers.set(name, value);
    }
  }

  const request = { ...ownedInit, headers };
  ownedInit = undefined;
  // Do not await here: the dispatch owner clears its body synchronously, then
  // this async frame can disappear while the upstream network wait continues.
  // eslint-disable-next-line @typescript-eslint/return-await
  return dispatchUpstreamFetch(options, `${entry.baseUrl}${path}`, request);
}

// Headers for management-plane calls on the selected GitHub API origin — token
// exchange and /copilot_internal/user.
// VSCode Copilot Chat (and caozhiyuan/copilot-api) deliberately omit editor-*
// here: those headers belong on the copilot data plane, not on the GitHub
// management plane. x-github-api-version uses GitHub's REST date, distinct
// from the Copilot data-plane version above.
export function githubHeaders(githubToken: string): Record<string, string> {
  return {
    authorization: `token ${githubToken}`,
    accept: 'application/json',
    'user-agent': USER_AGENT,
    'x-github-api-version': GITHUB_API_VERSION,
    'x-vscode-user-agent-library-version': 'electron-fetch',
  };
}
