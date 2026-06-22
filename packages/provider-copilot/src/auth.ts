import { readCopilotUpstreamState, type CopilotTokenEntry, type CopilotUpstreamState } from './state.ts';
import { getProviderRepo as getRepo, isAbortError, type Fetcher } from '@floway-dev/provider';

const COPILOT_BASE_URLS = {
  individual: 'https://api.individual.githubcopilot.com',
  business: 'https://api.business.githubcopilot.com',
  enterprise: 'https://api.enterprise.githubcopilot.com',
} as const;

export type CopilotAccountType = keyof typeof COPILOT_BASE_URLS;

const COPILOT_ACCOUNT_TYPES = Object.keys(COPILOT_BASE_URLS) as readonly CopilotAccountType[];

// Pro+, Max, and EDU all share the individual data-plane host. Full plan list:
// https://github.com/microsoft/vscode/blob/9fc5f412c92925bd5b2e41e2029006847432bde6/src/vs/workbench/services/chat/common/chatEntitlementService.ts
const COPILOT_PLAN_TO_ACCOUNT_TYPE: Record<string, CopilotAccountType> = {
  individual: 'individual',
  individual_pro: 'individual',
  individual_max: 'individual',
  individual_edu: 'individual',
  business: 'business',
  enterprise: 'enterprise',
};

// For already-normalized data-plane values; wire-side `copilot_plan` needs
// copilotPlanToAccountType() to collapse aliases first.
export const isCopilotAccountType = (value: unknown): value is CopilotAccountType =>
  typeof value === 'string' && COPILOT_ACCOUNT_TYPES.includes(value as CopilotAccountType);

// GitHub may grow new `copilot_plan` strings without notice, so unknown values
// throw rather than mapping to a default.
export const copilotPlanToAccountType = (plan: unknown): CopilotAccountType => {
  const accountType = typeof plan === 'string' ? COPILOT_PLAN_TO_ACCOUNT_TYPE[plan] : undefined;
  if (!accountType) throw new Error(`Unknown GitHub Copilot plan: ${JSON.stringify(plan)}`);
  return accountType;
};

// Version constants pinned to a known-good set. GitHub Copilot rejects too-new
// editor-plugin-version values (caozhiyuan/copilot-api@80e17dfd downgraded
// 0.48.0 → 0.47.1 after upstream broke on the newer one); dynamically tracking
// the latest VSCode release in a server-side gateway buys no realism and adds
// a startup HTTP dependency, so we pin both.
const COPILOT_VERSION = '0.47.1';
const VSCODE_VERSION = '1.119.1';
const EDITOR_VERSION = `vscode/${VSCODE_VERSION}`;
const EDITOR_PLUGIN_VERSION = `copilot-chat/${COPILOT_VERSION}`;
const USER_AGENT = `GitHubCopilotChat/${COPILOT_VERSION}`;
const COPILOT_API_VERSION = '2026-01-09';
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
// HTTP-convention 5xx range falls through to the retry path because GitHub
// returns 500/502/503/504 transiently when api.github.com itself is having
// a bad minute (caozhiyuan/copilot-api retries every refresh failure).
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

export class CopilotTokenFetchError extends Error {
  constructor(readonly status: number, readonly body: string, readonly headers: Headers) {
    super(`Copilot token fetch failed: ${status} ${body}`);
    this.name = 'CopilotTokenFetchError';
  }
}

export const isCopilotTokenFetchError = (error: unknown): error is CopilotTokenFetchError => error instanceof CopilotTokenFetchError;

export async function clearCopilotTokenCache(upstreamId: string): Promise<void> {
  // Drop both the in-process memo and the persisted `state.copilotToken`. The
  // persisted entry outlives the in-process clear by ~25 minutes, so a caller
  // that just rotated the upstream's GitHub PAT (or otherwise needs the next
  // request to mint a fresh Copilot token) MUST also wipe the persisted entry —
  // otherwise `getCopilotToken` would happily return the still-valid hydrated
  // token that was minted from the previous PAT, authenticating subsequent
  // requests as the prior identity until the natural expiry.
  inProcessTokenCache.clear();
  const repo = getRepo().upstreams;
  const fresh = await repo.getById(upstreamId);
  if (!fresh) return;
  const state = readCopilotUpstreamState(fresh.state);
  if (state.copilotToken === null) return;
  try {
    await repo.saveState(
      upstreamId,
      { ...state, copilotToken: null } satisfies CopilotUpstreamState,
      { expectedState: fresh.state },
    );
  } catch (err) {
    console.warn(`Failed to clear persisted Copilot token for ${upstreamId}:`, err);
  }
}

// Tests use this to drop only the process-local memo between cases — they
// run against a fresh DB per test so the persisted state needs no separate
// reset, and some tests deliberately want the next call to hydrate from
// state_json instead of minting a fresh token.
export function clearInProcessCopilotTokenCache(): void {
  inProcessTokenCache.clear();
}

async function withRetry<T>(fn: () => Promise<T>, signal: AbortSignal | undefined, maxRetries = 3, baseDelayMs = 1000): Promise<T> {
  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    try {
      return await fn();
    } catch (e) {
      // AbortError is a deliberate caller cancellation — propagate
      // immediately rather than walk N retries with the same already-
      // aborted signal, which would burn the proxy chain on each cycle.
      if (isAbortError(e)) throw e;
      if (isCopilotTokenFetchError(e) && isCopilotTokenFetchTerminalStatus(e.status)) {
        throw e;
      }
      if (attempt >= maxRetries) throw e;
      const delay = baseDelayMs * Math.pow(2, attempt);
      console.warn(`Retry ${attempt + 1}/${maxRetries} after ${delay}ms: ${e instanceof Error ? e.message : String(e)}`);
      // Honour the signal during backoff so a cancellation that fires
      // mid-sleep also unwinds promptly. `{ once: true }` only fires-then-
      // detaches; on the timer-resolve happy path we have to remove the
      // listener ourselves, otherwise a long-lived caller signal (one
      // shared across many retries / requests) accumulates one closure
      // per sleep pinning the closed-over `reject`.
      await new Promise<void>((resolve, reject) => {
        let onAbort: (() => void) | null = null;
        const timer = setTimeout(() => {
          if (onAbort && signal) signal.removeEventListener('abort', onAbort);
          resolve();
        }, delay);
        if (signal) {
          onAbort = (): void => {
            clearTimeout(timer);
            reject(signal.reason ?? new DOMException('aborted', 'AbortError'));
          };
          signal.addEventListener('abort', onAbort, { once: true });
        }
      });
    }
  }
  throw new Error('Unreachable');
}

function isTokenValid(token: string | null, expiresAt: number): boolean {
  if (!token) return false;
  const now = Math.floor(Date.now() / 1000);
  return expiresAt > now + 60;
}

async function getCopilotToken(upstreamId: string, githubToken: string, fetcher: Fetcher, signal: AbortSignal | undefined): Promise<string> {
  const now = Date.now();
  const cached = inProcessTokenCache.get(upstreamId);
  if (cached && isTokenValid(cached.entry.token, cached.entry.expiresAt) && now - cached.cachedAt < IN_PROCESS_TTL_MS) {
    return cached.entry.token;
  }

  const fresh = await getRepo().upstreams.getById(upstreamId);
  if (!fresh) throw new Error(`Copilot upstream ${upstreamId} disappeared mid-token-refresh`);
  const state = readCopilotUpstreamState(fresh.state);
  const persisted = state.copilotToken;
  if (persisted && isTokenValid(persisted.token, persisted.expiresAt)) {
    inProcessTokenCache.set(upstreamId, { entry: persisted, cachedAt: now });
    return persisted.token;
  }

  // Routed through the upstream's Fetcher so deployments behind a network
  // egress restriction (e.g. GFW) keep refreshing tokens through the same
  // proxy chain that carries the data-plane traffic; without this, a working
  // Copilot proxy would still see periodic auth-refresh failures every
  // ~25 minutes per process.
  return await withRetry(async () => {
    // Token exchange is a GET against api.github.com (not POST); matches
    // VSCode Copilot Chat and caozhiyuan/copilot-api. A POST returns 404.
    // Forward the data-plane request's signal so a client disconnect
    // during refresh tears the call down instead of burning the per-proxy
    // dial deadline before unwinding.
    const resp = await fetcher('https://api.github.com/copilot_internal/v2/token', {
      method: 'GET',
      headers: githubHeaders(githubToken),
      signal,
    });

    if (!resp.ok) {
      const text = await resp.text();
      throw new CopilotTokenFetchError(resp.status, text, new Headers(resp.headers));
    }

    const data = (await resp.json()) as {
      token: string;
      expires_at: number;
      refresh_in: number;
    };

    const entry: CopilotTokenEntry = {
      token: data.token,
      expiresAt: data.expires_at,
    };
    inProcessTokenCache.set(upstreamId, { entry, cachedAt: Date.now() });
    // Best-effort persistence: a losing CAS or transient DB error must not
    // invalidate the freshly fetched token, which the caller is about to use
    // to satisfy a live request. Mirrors the known-models persistence policy.
    try {
      await getRepo().upstreams.saveState(
        upstreamId,
        { ...state, copilotToken: entry } satisfies CopilotUpstreamState,
        { expectedState: fresh.state },
      );
    } catch (err) {
      console.warn(`Failed to persist Copilot token for ${upstreamId}:`, err);
    }

    return data.token;
  }, signal);
}

export interface CopilotFetchOptions {
  headers?: Headers;
  /** Per-request proxy-aware indirection. Used for both the data-plane
   *  request and the api.github.com token exchange so a single fallback
   *  chain covers both paths under restricted egress. */
  fetcher: Fetcher;
  /** Recorder threaded through the data-plane fetcher's per-attempt wrap.
   *  Deliberately not applied to the GitHub→Copilot token exchange: that
   *  hop is the gateway's own auth maintenance, not the user's request. */
  recordUpstreamLatency?: <T>(promise: Promise<T>) => Promise<T>;
}

export interface CopilotAuth {
  id: string;
  githubToken: string;
  accountType: CopilotAccountType;
}

export async function copilotAuthedFetch(path: string, init: RequestInit, auth: CopilotAuth, options: CopilotFetchOptions): Promise<Response> {
  const token = await getCopilotToken(auth.id, auth.githubToken, options.fetcher, init.signal ?? undefined);
  const baseUrl = COPILOT_BASE_URLS[auth.accountType];

  // x-request-id and x-agent-task-id share a single per-call UUID, mirroring
  // VSCode Copilot Chat's "one id ties the request to its background task" pattern.
  const requestId = crypto.randomUUID();

  const headers = new Headers(init.headers);
  headers.set('Authorization', `Bearer ${token}`);
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
  // ...) flow through unchanged. The provider's target interceptors decide
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

  return await options.fetcher(`${baseUrl}${path}`, { ...init, headers }, options.recordUpstreamLatency);
}

// Headers for api.github.com calls — token exchange and /copilot_internal/user.
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
