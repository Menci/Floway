import pRetry, { AbortError as RetryAbortError } from 'p-retry';

import { githubApiOrigin } from './github-host.ts';
import type { CopilotTokenEntry } from './state.ts';
import type { Fetcher, HttpHeaderLines } from '@floway-dev/provider';

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

export class CopilotTokenFetchError extends Error {
  constructor(readonly status: number, readonly body: string, readonly headers: Headers) {
    super(`Copilot token fetch failed: ${status} ${body}`);
    this.name = 'CopilotTokenFetchError';
  }
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

export const retryCopilotTokenFetch = async <T>(fn: () => Promise<T>, signal: AbortSignal | undefined): Promise<T> => {
  try {
    return await pRetry(async () => {
      try {
        return await fn();
      } catch (error) {
        if (signal?.aborted || (error instanceof DOMException && error.name === 'AbortError')
          || (isCopilotTokenFetchError(error) && isCopilotTokenFetchTerminalStatus(error.status))) {
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

// Pure exchange against /copilot_internal/v2/token — no caching, no
// persistence, no retry. CopilotService adds all three; the control-plane import path calls it once to validate
// the PAT and seed initial state. Method is GET, not POST — POST returns
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

const COPILOT_IDENTITY_HEADERS = {
  'editor-version': EDITOR_VERSION,
  'editor-plugin-version': EDITOR_PLUGIN_VERSION,
  'editor-device-id': '',
  'user-agent': USER_AGENT,
  'x-github-api-version': COPILOT_API_VERSION,
  'x-vscode-user-agent-library-version': 'electron-fetch',
  'x-request-id': '',
  'x-agent-task-id': '',
  'copilot-integration-id': 'vscode-chat',
  'openai-intent': 'conversation-agent',
  'x-interaction-type': 'conversation-agent',
};

export const isCopilotIdentityHeader = (name: string): boolean => Object.hasOwn(COPILOT_IDENTITY_HEADERS, name);

export const copilotIdentityHeaders = (): HttpHeaderLines => {
  // x-request-id and x-agent-task-id share a single per-call UUID, mirroring
  // VSCode Copilot Chat's "one id ties the request to its background task" pattern.
  const requestId = crypto.randomUUID();

  return Object.entries({
    ...COPILOT_IDENTITY_HEADERS,
    'editor-device-id': getEditorDeviceId(),
    'x-request-id': requestId,
    'x-agent-task-id': requestId,
  });
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
