import { getRepo } from '../repo/index.ts';

const COPILOT_BASE_URLS = {
  individual: 'https://api.githubcopilot.com',
  business: 'https://api.business.githubcopilot.com',
  enterprise: 'https://api.enterprise.githubcopilot.com',
} as const;

export type CopilotAccountType = keyof typeof COPILOT_BASE_URLS;

const COPILOT_ACCOUNT_TYPES = ['individual', 'business', 'enterprise'] as const satisfies readonly CopilotAccountType[];

export const isCopilotAccountType = (value: unknown): value is CopilotAccountType =>
  typeof value === 'string' && COPILOT_ACCOUNT_TYPES.includes(value as CopilotAccountType);

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

// User-agent VSCode Copilot Chat sends on its Claude Code SDK proxy path, used
// by `withClaudeAgentHeadersSet` when we detect Claude Code traffic. Bump this
// alongside COPILOT_VERSION when caozhiyuan/copilot-api upgrades it upstream.
export const CLAUDE_AGENT_USER_AGENT = 'vscode_claude_code/2.1.112 (external, sdk-ts, agent-sdk/0.2.112)';

// Stable per-isolate device id, like real VSCode generates once per install.
// Initialized lazily on first use because Workers forbid crypto.randomUUID()
// (and other async I/O / random / timers) in module-global scope.
let editorDeviceId: string | null = null;
const getEditorDeviceId = (): string => (editorDeviceId ??= crypto.randomUUID());

const isCopilotTokenFetchTerminalStatus = (status: number): boolean => status === 403 || status === 429 || status === 500;

// Two-level Copilot token cache: in-process (60s) + KV (cross-datacenter).
// In-process avoids KV reads on every request. KV avoids HTTP fetches on cold starts.
const LEGACY_COPILOT_TOKEN_KV_KEY = 'copilot_token';
const COPILOT_TOKEN_KV_KEY_PREFIX = 'copilot_token_v2';
const IN_PROCESS_TTL_MS = 60_000;
const inProcessTokenCache = new Map<
  string,
  {
    entry: CopilotTokenCacheEntry;
    cachedAt: number;
  }
>();

interface CopilotTokenCacheEntry {
  token: string;
  expiresAt: number;
}

export class CopilotTokenFetchError extends Error {
  constructor(readonly status: number, readonly body: string, readonly headers: Headers) {
    super(`Copilot token fetch failed: ${status} ${body}`);
    this.name = 'CopilotTokenFetchError';
  }
}

export const isCopilotTokenFetchError = (error: unknown): error is CopilotTokenFetchError => error instanceof CopilotTokenFetchError;

/** Clear the cached Copilot token from both in-process and KV storage */
export async function clearCopilotTokenCache(): Promise<void> {
  inProcessTokenCache.clear();
  try {
    await getRepo().cache.delete(LEGACY_COPILOT_TOKEN_KV_KEY);
    await getRepo().cache.deletePrefix(`${COPILOT_TOKEN_KV_KEY_PREFIX}:`);
  } catch {
    // Ignore — KV may not be available during initialization
  }
}

function copilotBaseUrl(accountType: CopilotAccountType): string {
  return COPILOT_BASE_URLS[accountType];
}

async function withRetry<T>(fn: () => Promise<T>, maxRetries = 3, baseDelayMs = 1000): Promise<T> {
  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    try {
      return await fn();
    } catch (e) {
      // Don't retry client errors (4xx) — they won't change on retry
      if (isCopilotTokenFetchError(e) && isCopilotTokenFetchTerminalStatus(e.status)) {
        throw e;
      }
      if (e instanceof Error && /failed: 4\d{2} /.test(e.message)) throw e;
      if (attempt >= maxRetries) throw e;
      const delay = baseDelayMs * Math.pow(2, attempt);
      console.warn(`Retry ${attempt + 1}/${maxRetries} after ${delay}ms: ${e instanceof Error ? e.message : String(e)}`);
      await new Promise(r => setTimeout(r, delay));
    }
  }
  throw new Error('Unreachable');
}

function isTokenValid(token: string | null, expiresAt: number): boolean {
  if (!token) return false;
  const now = Math.floor(Date.now() / 1000);
  return expiresAt > now + 60;
}

async function copilotTokenCacheKey(githubToken: string, accountType: string): Promise<string> {
  const bytes = new TextEncoder().encode(`${accountType}:${githubToken}`);
  const digest = await crypto.subtle.digest('SHA-256', bytes);
  const hash = Array.from(new Uint8Array(digest), byte => byte.toString(16).padStart(2, '0')).join('');
  return `${COPILOT_TOKEN_KV_KEY_PREFIX}:${hash}`;
}

async function getCopilotToken(githubToken: string): Promise<string> {
  const cacheKey = await copilotTokenCacheKey(githubToken, 'copilot');

  // Level 1: in-process cache (avoids KV read on hot path)
  const now = Date.now();
  const cached = inProcessTokenCache.get(cacheKey);
  if (cached && isTokenValid(cached.entry.token, cached.entry.expiresAt) && now - cached.cachedAt < IN_PROCESS_TTL_MS) {
    return cached.entry.token;
  }

  // Level 2: KV cache (cross-datacenter, survives isolate restarts)
  try {
    const raw = await getRepo().cache.get(cacheKey);
    if (raw) {
      const entry = JSON.parse(raw) as CopilotTokenCacheEntry;
      if (isTokenValid(entry.token, entry.expiresAt)) {
        inProcessTokenCache.set(cacheKey, { entry, cachedAt: now });
        return entry.token;
      }
    }
  } catch {
    // KV read failure is non-fatal — fall through to fetch
  }

  // Level 3: fetch from GitHub API
  return await withRetry(async () => {
    // Token exchange is a GET against api.github.com (not POST); matches
    // VSCode Copilot Chat and caozhiyuan/copilot-api. A POST returns 404.
    const resp = await fetch('https://api.github.com/copilot_internal/v2/token', {
      headers: githubHeaders(githubToken),
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

    const entry: CopilotTokenCacheEntry = {
      token: data.token,
      expiresAt: data.expires_at,
    };
    inProcessTokenCache.set(cacheKey, { entry, cachedAt: Date.now() });
    getRepo()
      .cache.set(cacheKey, JSON.stringify(entry))
      .catch(() => {});

    return data.token;
  });
}

export interface CopilotFetchOptions {
  headers?: Record<string, string>;
}

export async function copilotFetch(path: string, init: RequestInit, githubToken: string, accountType: CopilotAccountType, options?: CopilotFetchOptions): Promise<Response> {
  const token = await getCopilotToken(githubToken);
  const baseUrl = copilotBaseUrl(accountType);

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
  if (options?.headers) {
    for (const [name, value] of Object.entries(options.headers)) {
      if (value === '') headers.delete(name);
      else headers.set(name, value);
    }
  }

  return await fetch(`${baseUrl}${path}`, { ...init, headers });
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
