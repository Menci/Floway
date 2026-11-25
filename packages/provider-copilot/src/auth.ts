import pRetry, { AbortError as RetryAbortError } from 'p-retry';

import { githubApiOrigin } from './github-host.ts';
import { readCopilotUpstreamState, type CopilotTokenEntry, type CopilotUpstreamState } from './state.ts';
import { getProviderRepo as getRepo, isAbortError, type Fetcher, type HttpHeaderLines } from '@floway-dev/provider';

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

export class CopilotTokenFetchError extends Error {
  constructor(readonly response: Response, readonly body: string) {
    super(`Copilot token fetch failed: ${response.status} ${body}`);
    this.name = 'CopilotTokenFetchError';
  }

  get status(): number { return this.response.status; }
  get headers(): Headers { return this.response.headers; }
}

export const isCopilotTokenFetchError = (error: unknown): error is CopilotTokenFetchError => error instanceof CopilotTokenFetchError;

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

const retryCopilotTokenFetch = async <T>(fn: () => Promise<T>): Promise<T> => {
  try {
    return await pRetry(async () => {
      try {
        return await fn();
      } catch (error) {
        if (isAbortError(error) || (isCopilotTokenFetchError(error) && isCopilotTokenFetchTerminalStatus(error.status))) {
          throw new RetryAbortError(error instanceof Error ? error : new NonErrorAbort(error));
        }

        // p-retry skips non-network TypeErrors and normalizes non-Error rejections.
        // Keep the original value across retries and restore it at the boundary.
        if (!(error instanceof Error) || error instanceof TypeError) throw new RetryableError(error);
        throw error;
      }
    }, {
      retries: 3,
      factor: 2,
      minTimeout: 1000,
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

export const createCopilotCredentials = () => {
  // Copilot derives one device ID per editor installation.
  // https://github.com/caozhiyuan/copilot-api/blob/b16e01909e747b5ad49ce38137a6c1453e0052a6/src/lib/api-config.ts
  let editorDeviceId: string | null = null;
  const getEditorDeviceId = (): string => (editorDeviceId ??= crypto.randomUUID());
  const inProcessTokenCache = new Map<
    string,
    {
      entry: CopilotTokenEntry;
      cachedAt: number;
      githubHost: string;
      githubToken: string;
    }
  >();
  const pendingTokenExchanges = new Map<string, {
    githubHost: string;
    githubToken: string;
    task: Promise<CopilotTokenEntry>;
  }>();
  let generation = 0;

  const identityHeaders = (): HttpHeaderLines => {
    const requestId = crypto.randomUUID();
    return [
      ['editor-version', EDITOR_VERSION],
      ['editor-plugin-version', EDITOR_PLUGIN_VERSION],
      ['editor-device-id', getEditorDeviceId()],
      ['user-agent', USER_AGENT],
      ['x-github-api-version', COPILOT_API_VERSION],
      ['x-vscode-user-agent-library-version', 'electron-fetch'],
      ['x-request-id', requestId],
      ['x-agent-task-id', requestId],
      ['copilot-integration-id', 'vscode-chat'],
      ['openai-intent', 'conversation-agent'],
      ['x-interaction-type', 'conversation-agent'],
    ];
  };

  const readOrExchangeToken = async (
    upstreamId: string,
    githubHost: string,
    githubToken: string,
    fetcher: Fetcher,
  ): Promise<CopilotTokenEntry> => {
    const started = generation;
    const now = Date.now();
    const cached = inProcessTokenCache.get(upstreamId);
    if (cached?.githubHost === githubHost && cached.githubToken === githubToken && isTokenValid(cached.entry.token, cached.entry.expiresAt) && now - cached.cachedAt < IN_PROCESS_TTL_MS) {
      return cached.entry;
    }

    const fresh = await getRepo().upstreams.getById(upstreamId);
    if (!fresh) throw new Error(`Copilot upstream ${upstreamId} disappeared mid-token-refresh`);
    const state = readCopilotUpstreamState(fresh.state);
    const persisted = state.copilotToken;
    if (persisted && isTokenValid(persisted.token, persisted.expiresAt)) {
      if (started === generation) inProcessTokenCache.set(upstreamId, { entry: persisted, cachedAt: now, githubHost, githubToken });
      return persisted;
    }

    // Routed through the upstream's Fetcher so deployments behind a network
    // egress restriction (e.g. GFW) keep refreshing tokens through the same
    // proxy chain that carries the data-plane traffic; without this, a working
    // Copilot proxy would still see periodic auth-refresh failures every
    // ~25 minutes per process.
    return await retryCopilotTokenFetch(async () => {
      const entry = await exchangeCopilotToken(githubHost, githubToken, fetcher);
      if (started !== generation) return entry;
      inProcessTokenCache.set(upstreamId, { entry, cachedAt: Date.now(), githubHost, githubToken });
      // Best-effort: the caller is about to satisfy a live request with this
      // token, so a storage failure costs the next cold isolate one extra mint
      // rather than the request. Swallowing here also keeps such a failure out
      // of retryCopilotTokenFetch, which would otherwise answer it by minting
      // again.
      try {
        await getRepo().upstreams.saveState(upstreamId, (current, configVersion) => {
          if (configVersion !== fresh.configVersion) return current;
          return {
            ...readCopilotUpstreamState(current),
            copilotToken: entry,
          } satisfies CopilotUpstreamState;
        });
      } catch (err) {
        console.warn(`Failed to persist Copilot token for ${upstreamId}:`, err);
      }
      return entry;
    });
  };

  const getCopilotToken = async (
    upstreamId: string,
    githubHost: string,
    githubToken: string,
    fetcher: Fetcher,
  ): Promise<CopilotTokenEntry> => {
    const current = pendingTokenExchanges.get(upstreamId);
    if (current?.githubHost === githubHost && current.githubToken === githubToken) return await current.task;

    // Every waiter for these GitHub credentials shares the service-owned
    // exchange. An individual request can abort without cancelling the mint.
    const task = readOrExchangeToken(upstreamId, githubHost, githubToken, fetcher);
    pendingTokenExchanges.set(upstreamId, { githubHost, githubToken, task });
    try {
      return await task;
    } finally {
      if (pendingTokenExchanges.get(upstreamId)?.task === task) pendingTokenExchanges.delete(upstreamId);
    }
  };

  return {
    getCopilotToken,
    identityHeaders,
    clear() {
      generation++;
      inProcessTokenCache.clear();
      pendingTokenExchanges.clear();
    },
  };
};

// Pure exchange against /copilot_internal/v2/token — no caching, no
// persistence, no retry. Callers that want those wrap it (getCopilotToken
// adds all three; the control-plane import path calls it once to validate
// the PAT and seed initial state). Method is GET, not POST — POST returns
// 404 from this endpoint (matches VSCode Copilot Chat and caozhiyuan/copilot-
// api). `endpoints.api` is the per-tier data-plane host GitHub routes this
// PAT to. It travels with the token because they share a lifetime.
// https://github.com/microsoft/vscode-copilot-chat/blob/5863f5a7088958050792b5dccbe8b46c6e13eccc/src/platform/endpoint/common/domainServiceImpl.ts
export async function exchangeCopilotToken(githubHost: string, githubToken: string, fetcher: Fetcher, signal?: AbortSignal): Promise<CopilotTokenEntry> {
  const resp = await fetcher(`${githubApiOrigin(githubHost)}/copilot_internal/v2/token`, {
    method: 'GET',
    headers: githubHeaders(githubToken),
    signal,
  });

  if (!resp.ok) {
    const text = await resp.text();
    throw new CopilotTokenFetchError(resp, text);
  }

  const data = (await resp.json()) as {
    token: string;
    expires_at: number;
    refresh_in: number;
    endpoints?: { api?: string };
  };

  const baseUrl = data.endpoints?.api;
  if (typeof baseUrl !== 'string' || baseUrl === '') {
    throw new Error('Copilot token exchange response missing endpoints.api');
  }

  return {
    token: data.token,
    expiresAt: data.expires_at,
    baseUrl,
  };
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
