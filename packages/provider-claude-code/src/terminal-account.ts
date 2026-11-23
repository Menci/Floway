import { logWarn } from './log.ts';
import { readClaudeCodeUpstreamState, replaceSoleAccount, type ClaudeCodeAccountCredential } from './state.ts';
import type { PersistenceResult } from './usage-persistence.ts';
import { Bytes, snapshotError, type Deferred, type ErrorSnapshot, type ReleasingInner, type StageEnv } from '@floway-dev/pipeline';
import { getProviderRepo, type HttpResponseFacts, type ProviderServices } from '@floway-dev/provider';

// Credential-class terminal sentinels on the data-plane response body. Both
// signal a permanently disabled org that no retry, refresh, or re-import
// can recover — the operator must contact Anthropic. Matching the
// lowercased `error.message` substring mirrors sub2api
// `ratelimit_service.go:208-214` (400 path) and CRS
// `claudeRelayService.js:140-153` (`_isOrganizationDisabledError`, both
// 400 and 403). We match on "organization has been disabled" rather than
// CRS's slightly longer "this organization has been disabled" so a body
// that omits the leading "this" still matches (sub2api uses the shorter
// form too).
// https://github.com/Wei-Shaw/sub2api/blob/4a5665da5b2c6b83c4597844ea6e573746c821b1/backend/internal/service/ratelimit_service.go#L208-L214
const ORG_DISABLED_400_SENTINEL = 'organization has been disabled';
const ORG_BANNED_403_SENTINEL = 'oauth authentication is currently not allowed';

interface AnthropicErrorBody {
  error?: { type?: unknown; message?: unknown };
}

// Returns the operator-facing terminal message when the response matches
// one of the credential-class sentinels, or `null` otherwise. The body
// parse is intentionally defensive: a 400/403 that isn't JSON (or whose
// JSON shape doesn't match `{error:{type,message}}`) is the common case
// for unrelated errors (`max_tokens` validation, beta-feature gating,
// etc.) and must NOT trigger a terminal flip.
const detectTerminalSentinel = (status: number, bodyText: string): string | null => {
  if (status !== 400 && status !== 403) return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(bodyText);
  } catch {
    logWarn('claude_code_unparseable_error_body', { status, body_snippet: bodyText.slice(0, 256) });
    return null;
  }
  if (typeof parsed !== 'object' || parsed === null) return null;
  const error = (parsed as AnthropicErrorBody).error;
  if (typeof error !== 'object' || error === null) return null;
  const type = error.type;
  const message = error.message;
  if (typeof type !== 'string' || typeof message !== 'string') return null;
  const lowered = message.toLowerCase();
  if (status === 400 && type === 'invalid_request_error' && lowered.includes(ORG_DISABLED_400_SENTINEL)) {
    return `Organization disabled by Anthropic — re-import will not recover; contact support: ${message}`;
  }
  if (status === 403 && type === 'permission_error' && lowered.includes(ORG_BANNED_403_SENTINEL)) {
    return `Organization banned from OAuth by Anthropic — re-import will not recover; contact support: ${message}`;
  }
  return null;
};

// Preserve the first terminal diagnosis when an OAuth failure or sibling request
// has already flipped the account.
const persistTerminalAccountState = async (
  upstreamId: string,
  terminalMessage: string,
  reason: string,
  upstreamStatus: number,
): Promise<void> => {
  // Stamped before the write for the same reason as the quota snapshot: a
  // replay must produce the same document.
  const flippedAt = new Date().toISOString();
  let previousAccount!: ClaudeCodeAccountCredential;
  await getProviderRepo().upstreams.saveState(upstreamId, current => {
    const state = readClaudeCodeUpstreamState(current);
    previousAccount = state.accounts[0];
    if (previousAccount.state !== 'active') return state;
    return replaceSoleAccount(state, account => ({
      ...account,
      state: 'refresh_failed',
      stateMessage: terminalMessage,
      stateUpdatedAt: flippedAt,
      accessToken: null,
    }));
  });
  if (previousAccount.state !== 'active') return;
  logWarn('claude_code_account_state_flip', {
    upstream_id: upstreamId,
    account_uuid: previousAccount.accountUuid,
    from_state: previousAccount.state,
    to_state: 'refresh_failed',
    reason,
    upstream_status: upstreamStatus,
    message: terminalMessage,
  });
};

// Terminal detection needs the complete JSON error envelope. The cap allows
// room for additional error metadata while bounding retained bytes.
// https://github.com/Menci/Floway/blob/f4089ac480ef97c915a89f0df6d1ff11b0a57150/packages/provider-claude-code/src/fetch.ts#L287-L302
const TERMINAL_SENTINEL_BYTE_LIMIT = 64 * 1024;
// Allow an upstream that is still sending the error to finish after release
// while bounding the wait for a stalled body.
const TERMINAL_SENTINEL_DRAIN_TIMEOUT_MS = 1000;

type SentinelVerdict =
  | { readonly kind: 'terminal'; readonly message: string }
  | { readonly kind: 'not-terminal' }
  | { readonly kind: 'incomplete'; readonly reason: 'byte_limit' | 'deadline' | 'cancelled' | 'leaked' | 'released' }
  | { readonly kind: 'unreadable'; readonly error: ErrorSnapshot };

export type TerminalSentinelResult = Exclude<SentinelVerdict, { kind: 'terminal' }> | PersistenceResult;

const classify = (status: number, body: Bytes): SentinelVerdict => {
  if (body.byteLength > TERMINAL_SENTINEL_BYTE_LIMIT) return { kind: 'incomplete', reason: 'byte_limit' };
  const message = detectTerminalSentinel(status, body.utf8());
  return message === null ? { kind: 'not-terminal' } : { kind: 'terminal', message };
};

const drain = async (inner: ReleasingInner<Bytes>, observe: (chunk: Bytes) => boolean): Promise<'complete' | 'byte_limit' | 'deadline'> => {
  const expiry = Symbol('sentinel drain deadline');
  const deadline = Promise.withResolvers<typeof expiry>();
  const expiresAt = performance.now() + TERMINAL_SENTINEL_DRAIN_TIMEOUT_MS;
  const timer = setTimeout(() => deadline.resolve(expiry), TERMINAL_SENTINEL_DRAIN_TIMEOUT_MS);
  try {
    for (;;) {
      if (performance.now() >= expiresAt) return 'deadline';
      const part = await Promise.race([inner.next(), deadline.promise]);
      if (part === expiry) return 'deadline';
      if (part.done) return 'complete';
      if (!observe(part.value)) return 'byte_limit';
    }
  } finally {
    clearTimeout(timer);
  }
};

export const observeTerminalSentinel = (
  upstreamId: string,
  response: HttpResponseFacts,
  env: StageEnv<ProviderServices>,
): { readonly response: HttpResponseFacts; readonly observation: Deferred<TerminalSentinelResult> | undefined } => {
  const { status, body } = response;
  if (status !== 400 && status !== 403) return { response, observation: undefined };
  const log = (event: string, extra: Record<string, string>) => {
    const fields = { upstream_id: upstreamId, upstream_status: status, ...extra };
    logWarn(event, fields);
    env.log.warn(event, fields);
  };
  const persist = async (verdict: SentinelVerdict): Promise<TerminalSentinelResult> => {
    if (verdict.kind !== 'terminal') return verdict;
    const reason = status === 400 ? 'org_disabled_400_sentinel' : 'org_banned_403_sentinel';
    log('claude_code_terminal_sentinel_detected', { reason });
    try {
      await persistTerminalAccountState(upstreamId, verdict.message, reason, status);
      return { persisted: true };
    } catch (cause) {
      log('claude_code_terminal_sentinel_persist_failed', { error: String(cause) });
      return { persisted: false, error: snapshotError(cause) };
    }
  };
  if (body === null || body instanceof Bytes) {
    return { response, observation: env.defer('claude-code.terminal-sentinel', persist(classify(status, body ?? Bytes.empty))) };
  }

  let length = 0;
  let overLimit = false;
  const parts: Bytes[] = [];
  const observe = (part: Bytes): boolean => {
    if (overLimit) return false;
    length += part.byteLength;
    if (length > TERMINAL_SENTINEL_BYTE_LIMIT) {
      overLimit = true;
      parts.length = 0;
      return false;
    }
    if (part.byteLength > 0) parts.push(part);
    return true;
  };
  const unreadable = (cause: unknown): SentinelVerdict => {
    log('claude_code_terminal_sentinel_body_read_failed', { error: String(cause) });
    return { kind: 'unreadable', error: snapshotError(cause) };
  };
  const finish = () => classify(status, Bytes.concat(parts));
  const forwarded = env.wrapStream(body, {
    label: 'claude-code.terminal-sentinel',
    async *transform(source) {
      for await (const part of source) {
        observe(part);
        yield part;
      }
    },
    async onClose(end, inner) {
      if (overLimit) {
        verdict.resolve({ kind: 'incomplete', reason: 'byte_limit' });
        return;
      }
      switch (end.how) {
      case 'exhausted':
        verdict.resolve(finish());
        return;
      case 'errored':
        verdict.resolve(unreadable(end.error));
        return;
      case 'cancelled':
      case 'leaked':
        verdict.resolve({ kind: 'incomplete', reason: end.how });
        return;
      case 'released':
        break;
      }
      if (inner === null) {
        verdict.resolve({ kind: 'incomplete', reason: 'released' });
        return;
      }
      let drained: Awaited<ReturnType<typeof drain>>;
      try {
        drained = await drain(inner, observe);
      } catch (cause) {
        verdict.resolve(unreadable(cause));
        return;
      }
      if (env.signal.aborted) {
        verdict.resolve({ kind: 'incomplete', reason: 'cancelled' });
        return;
      }
      verdict.resolve(drained === 'complete' ? finish() : { kind: 'incomplete', reason: drained });
    },
  });
  const verdict = env.deferred<SentinelVerdict>('claude-code.terminal-sentinel.verdict', forwarded);
  // Settlement starts with observation; database latency stays out of body delivery.
  const observation = env.defer('claude-code.terminal-sentinel', verdict.deferred.promise.then(persist));
  return { response: { ...response, body: forwarded }, observation };
};
