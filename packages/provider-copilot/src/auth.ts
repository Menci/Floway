import { githubApiOrigin } from './github-host.ts';
import type { CopilotCredentialFailure } from './service.ts';
import { readCopilotUpstreamState, type CopilotTokenEntry, type CopilotUpstreamState } from './state.ts';
import { readHttpResponseText, responseHeaderEntries } from '@floway-dev/http';
import type { Result } from '@floway-dev/pipeline';
import { isJsonObject } from '@floway-dev/protocols/common';
import { getProviderRepo as getRepo, type Fetcher, type HttpHeaderLines, type ProviderServices } from '@floway-dev/provider';

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

const retryCopilotTokenFetch = async (fetch: () => ReturnType<typeof exchangeCopilotTokenResult>): ReturnType<typeof exchangeCopilotTokenResult> => {
  for (let attempt = 1; ; attempt++) {
    const result = await fetch();
    if (result.ok || attempt === 4) return result;
    const { error } = result;
    let cause: unknown;
    if (isCopilotTokenFetchError(error)) {
      if (isCopilotTokenFetchTerminalStatus(error.status)) return result;
      cause = error;
    } else if (error.kind === 'transport' && error.error.kind === 'transport') {
      cause = error.error.cause;
    } else {
      return result;
    }
    const delay = 1000 * 2 ** (attempt - 1);
    console.warn(`Retry ${attempt}/3 after ${delay}ms: ${cause instanceof Error ? cause.message : String(cause)}`);
    await new Promise<void>(resolve => { setTimeout(resolve, delay); });
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
    task: ReturnType<typeof exchangeCopilotTokenResult>;
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
    fetcher: ReturnType<ProviderServices['fetcher']>,
  ): ReturnType<typeof exchangeCopilotTokenResult> => {
    const started = generation;
    const now = Date.now();
    const cached = inProcessTokenCache.get(upstreamId);
    if (cached?.githubHost === githubHost && cached.githubToken === githubToken && isTokenValid(cached.entry.token, cached.entry.expiresAt) && now - cached.cachedAt < IN_PROCESS_TTL_MS) {
      return { ok: true, value: cached.entry };
    }

    const { upstreams } = getRepo();
    const fresh = await upstreams.getById(upstreamId);
    if (!fresh) return { ok: false, error: { kind: 'local', message: `Copilot upstream ${upstreamId} disappeared mid-token-refresh` } };
    const state = readCopilotUpstreamState(fresh.state);
    const persisted = state.copilotToken;
    if (persisted && isTokenValid(persisted.token, persisted.expiresAt)) {
      if (started === generation) inProcessTokenCache.set(upstreamId, { entry: persisted, cachedAt: now, githubHost, githubToken });
      return { ok: true, value: persisted };
    }

    // Routed through the upstream's Fetcher so deployments behind a network
    // egress restriction (e.g. GFW) keep refreshing tokens through the same
    // proxy chain that carries the data-plane traffic; without this, a working
    // Copilot proxy would still see periodic auth-refresh failures every
    // ~25 minutes per process.
    const result = await retryCopilotTokenFetch(() => exchangeCopilotTokenResult(githubHost, githubToken, fetcher));
    if (!result.ok || started !== generation) return result;
    const entry = result.value;
    inProcessTokenCache.set(upstreamId, { entry, cachedAt: Date.now(), githubHost, githubToken });
    // The minted token can serve this request even when its cache write fails.
    try {
      await upstreams.saveState(upstreamId, (current, configVersion) => {
        if (configVersion !== fresh.configVersion) return current;
        return {
          ...readCopilotUpstreamState(current),
          copilotToken: entry,
        } satisfies CopilotUpstreamState;
      });
    } catch (err) {
      console.warn(`Failed to persist Copilot token for ${upstreamId}:`, err);
    }
    return result;
  };

  const getCopilotToken = async (
    upstreamId: string,
    githubHost: string,
    githubToken: string,
    fetcher: ReturnType<ProviderServices['fetcher']>,
  ): ReturnType<typeof exchangeCopilotTokenResult> => {
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
const exchangeCopilotTokenResult = async (
  githubHost: string,
  githubToken: string,
  fetcher: ReturnType<ProviderServices['fetcher']>,
  signal?: AbortSignal,
): Promise<Result<CopilotTokenEntry, CopilotTokenFetchError | Exclude<CopilotCredentialFailure, { kind: 'response' }>>> => {
  const response = await fetcher(`${githubApiOrigin(githubHost)}/copilot_internal/v2/token`, {
    method: 'GET',
    headers: githubHeaders(githubToken),
    signal,
  });

  if (!response.ok) return { ok: false, error: { kind: 'transport', error: response.error } };
  const { value: resp } = response;
  const text = await readHttpResponseText(resp, signal);
  if (!text.ok) return { ok: false, error: { kind: 'transport', error: text.error } };
  if (!resp.ok) return { ok: false, error: new CopilotTokenFetchError(resp, text.value) };

  const http = { status: resp.status, statusText: resp.statusText, headers: responseHeaderEntries(resp) };
  let data: unknown;
  try {
    data = JSON.parse(text.value);
  } catch (error) {
    if (!(error instanceof SyntaxError)) throw error;
    return { ok: false, error: { kind: 'invalid-response', http, message: 'Copilot token exchange returned invalid JSON' } };
  }
  if (!isJsonObject(data) || typeof data.token !== 'string' || data.token === '' || typeof data.expires_at !== 'number' || !Number.isFinite(data.expires_at)) {
    return { ok: false, error: { kind: 'invalid-response', http, message: 'Copilot token exchange response missing a valid token or expiry' } };
  }
  const baseUrl = isJsonObject(data.endpoints) ? data.endpoints.api : undefined;
  if (typeof baseUrl !== 'string' || baseUrl === '') {
    return { ok: false, error: { kind: 'invalid-response', http, message: 'Copilot token exchange response missing endpoints.api' } };
  }
  return { ok: true, value: { token: data.token, expiresAt: data.expires_at, baseUrl } };
};

export const exchangeCopilotToken = async (githubHost: string, githubToken: string, fetcher: Fetcher, signal?: AbortSignal): Promise<CopilotTokenEntry> => {
  const result = await exchangeCopilotTokenResult(githubHost, githubToken,
    async (url, init) => ({ ok: true, value: await fetcher(url, init) }), signal);
  if (result.ok) return result.value;
  const { error } = result;
  if (isCopilotTokenFetchError(error)) throw error;
  if (error.kind === 'transport') throw error.error.cause;
  throw new Error(error.message);
};

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
