import pRetry from 'p-retry';

import type { CopilotUpstream } from './config.ts';
import { githubApiOrigin } from './github-host.ts';
import type { CopilotTokenEntry } from './state.ts';
import { isCausedBy, sendHttpRequest, type Fetcher, type HttpBodyError, type HttpHeaders, type HttpResponseFact, type HttpStreamError, type ProviderFetcher } from '@floway-dev/http';
import type { Result } from '@floway-dev/pipeline';
import { isJsonObject } from '@floway-dev/protocols/common';

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

export type CopilotWarning = (message: string, error: unknown) => void;
export type ObserveCopilotHeaders = (headers: HttpHeaders) => void;

type ResponseHead = Omit<HttpResponseFact, 'body'>;
type ResponseBody = AsyncGenerator<Result<Uint8Array, HttpBodyError>, void, unknown>;
export type CopilotCredentialFailure =
  | { kind: 'http'; head: ResponseHead; body: ResponseBody | null }
  | { kind: 'io'; head: ResponseHead; error: HttpBodyError }
  | { kind: 'io'; head: null; error: HttpStreamError };

export class CopilotTokenFetchError extends Error {
  constructor(readonly status: number, readonly body: string, readonly headers: Headers) {
    super(`Copilot token fetch failed: ${status} ${body}`);
    this.name = 'CopilotTokenFetchError';
  }
}

// https://github.com/microsoft/vscode/blob/a234109a108ad2ca78b7d0883688b0a84e3fab42/extensions/copilot/src/platform/endpoint/node/chatEndpoint.ts
export const copilotIdentityHeaders = (deviceId: string): HttpHeaders => {
  const requestId = crypto.randomUUID();
  return [
    ['editor-version', EDITOR_VERSION],
    ['editor-plugin-version', EDITOR_PLUGIN_VERSION],
    ['editor-device-id', deviceId],
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

// The GitHub management plane uses the REST API version and omits editor
// headers. Copilot returns the per-tier API origin alongside the bearer.
// https://github.com/caozhiyuan/copilot-api/blob/b16e01909e747b5ad49ce38137a6c1453e0052a6/src/lib/api-config.ts
const tokenUrl = (githubHost: string): string => `${githubApiOrigin(githubHost)}/copilot_internal/v2/token`;

export const githubHeaders = (githubToken: string): Record<string, string> => ({
  authorization: `token ${githubToken}`,
  accept: 'application/json',
  'user-agent': USER_AGENT,
  'x-github-api-version': GITHUB_API_VERSION,
  'x-vscode-user-agent-library-version': 'electron-fetch',
});

const parseToken = (value: unknown): CopilotTokenEntry => {
  if (
    !isJsonObject(value) || typeof value.token !== 'string' || value.token.length === 0
    || typeof value.expires_at !== 'number' || !Number.isFinite(value.expires_at)
    || !isJsonObject(value.endpoints) || typeof value.endpoints.api !== 'string' || value.endpoints.api.length === 0
  ) {
    throw new TypeError('Invalid Copilot token exchange response');
  }
  return { token: value.token, expiresAt: value.expires_at, baseUrl: value.endpoints.api };
};

export const exchangeCopilotToken = async (
  githubHost: string,
  githubToken: string,
  fetcher: Fetcher,
  signal?: AbortSignal,
): Promise<CopilotTokenEntry> => {
  const response = await fetcher(tokenUrl(githubHost), { method: 'GET', headers: githubHeaders(githubToken), signal });
  if (!response.ok) throw new CopilotTokenFetchError(response.status, await response.text(), response.headers);
  return parseToken(await response.json());
};

class TokenExchangeFailure extends Error {
  constructor(readonly failure: CopilotCredentialFailure) {
    super(failure.kind === 'http' ? `Copilot token exchange returned HTTP ${failure.head.status}` : 'Copilot token exchange failed',
      failure.kind === 'io' ? { cause: failure.error.cause } : undefined);
  }
}

const TOKEN_RESPONSE_LIMIT_BYTES = 256 * 1024;
const TOKEN_EXCHANGE_RETRIES = 3;

const readToken = async (
  upstream: CopilotUpstream,
  fetcher: ProviderFetcher,
  signal: AbortSignal,
  observeHeaders: ObserveCopilotHeaders,
): Promise<CopilotTokenEntry> => {
  const { githubHost, githubToken } = upstream.config;
  const authorization = githubToken.map(token => `token ${token}`);
  const headers: HttpHeaders = [
    ['authorization', authorization],
    ['accept', 'application/json'],
    ['user-agent', USER_AGENT],
    ['x-github-api-version', GITHUB_API_VERSION],
    ['x-vscode-user-agent-library-version', 'electron-fetch'],
  ];
  const sent = await sendHttpRequest(fetcher, { url: tokenUrl(githubHost), method: 'GET', headers, body: null }, signal);
  if (!sent.ok) throw new TokenExchangeFailure({ kind: 'io', head: null, error: sent.error });
  const { body, ...head } = sent.value;
  observeHeaders(head.headers);
  if (head.status < 200 || head.status >= 300) throw new TokenExchangeFailure({ kind: 'http', head, body });
  const chunks: Uint8Array[] = [];
  let size = 0;
  if (body !== null) {
    for await (const item of body) {
      if (!item.ok) throw new TokenExchangeFailure({ kind: 'io', head, error: item.error });
      size += item.value.byteLength;
      if (size > TOKEN_RESPONSE_LIMIT_BYTES) throw new RangeError(`Copilot token response exceeds ${TOKEN_RESPONSE_LIMIT_BYTES} bytes`);
      chunks.push(item.value);
    }
  }
  const bytes = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return parseToken(JSON.parse(new TextDecoder().decode(bytes)));
};

// 403 and 429 are terminal; waiting out GitHub's rate-limit window cannot
// help within the request's retry budget. Other recorded I/O failures use
// the same 1s, 2s and 4s backoff as the token refresh.
// https://github.com/caozhiyuan/copilot-api/blob/b16e01909e747b5ad49ce38137a6c1453e0052a6/src/services/copilot/get-copilot-token.ts
const retryable = (error: Error): boolean => {
  if (!(error instanceof TokenExchangeFailure)) return false;
  const { failure } = error;
  return failure.kind === 'http'
    ? failure.head.status !== 403 && failure.head.status !== 429
    : failure.error.kind !== 'abort';
};

export const resolveCopilotToken = async (
  upstream: CopilotUpstream,
  fetcher: ProviderFetcher,
  signal: AbortSignal,
  warn: CopilotWarning,
  observeHeaders: ObserveCopilotHeaders,
): Promise<Result<CopilotTokenEntry, CopilotCredentialFailure>> => {
  let terminal: { error: unknown } | undefined;
  let attempts = 0;
  try {
    const value = await pRetry(async () => {
      attempts++;
      try {
        return await readToken(upstream, fetcher, signal, observeHeaders);
      } catch (error) {
        // p-retry replaces any rejection with the signal's reason if the
        // signal changed concurrently. Retain the completed I/O failure.
        if (!(error instanceof Error) || !retryable(error) || attempts > TOKEN_EXCHANGE_RETRIES) terminal = { error };
        throw error;
      }
    }, {
      retries: TOKEN_EXCHANGE_RETRIES,
      factor: 2,
      minTimeout: 1000,
      signal,
      async shouldRetry({ error }) {
        if (!(error instanceof TokenExchangeFailure) || !retryable(error) || signal.aborted) return false;
        if (error.failure.kind === 'http') await error.failure.body?.return();
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
    const error = terminal === undefined ? cause : terminal.error;
    if (error instanceof TokenExchangeFailure) return { ok: false, error: error.failure };
    if (terminal === undefined && isCausedBy(error, signal.reason)) {
      return { ok: false, error: { kind: 'io', head: null, error: { kind: 'abort', cause: error } } };
    }
    throw error;
  }
};
