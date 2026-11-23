import { logWarn } from './log.ts';
import type { ClaudeCodeServices, PersistenceResult } from './service.ts';
import { Bytes, type ErrorSnapshot, type ReleasingInner, type Scope, type StreamEnd } from '@floway-dev/pipeline';
import { isTransportFailure, type HttpResponseBodyChunk, type HttpResponseFacts, type TransportFailure } from '@floway-dev/provider';

// https://github.com/Wei-Shaw/sub2api/blob/4a5665da5b2c6b83c4597844ea6e573746c821b1/backend/internal/service/ratelimit_service.go#L208-L214
const ORG_DISABLED_400_SENTINEL = 'organization has been disabled';
const ORG_BANNED_403_SENTINEL = 'oauth authentication is currently not allowed';

interface AnthropicErrorBody {
  error?: { type?: unknown; message?: unknown };
}

// Terminal detection needs the complete JSON error envelope. The cap allows
// room for additional error metadata while bounding retained bytes.
// https://github.com/Menci/Floway/blob/f4089ac480ef97c915a89f0df6d1ff11b0a57150/packages/provider-claude-code/src/fetch.ts#L287-L302
const TERMINAL_SENTINEL_BYTE_LIMIT = 64 * 1024;
const TERMINAL_SENTINEL_DRAIN_TIMEOUT_MS = 1000;

export interface TerminalSentinel {
  readonly kind: 'terminal';
  readonly status: 400 | 403;
  readonly reason: 'org_disabled_400_sentinel' | 'org_banned_403_sentinel';
  readonly message: string;
}

type SentinelVerdict =
  | TerminalSentinel
  | { readonly kind: 'not-terminal' }
  | { readonly kind: 'incomplete'; readonly reason: 'byte_limit' | 'deadline' | 'cancelled' | 'leaked' | 'released' }
  | { readonly kind: 'unreadable'; readonly error: ErrorSnapshot };

type SentinelResult = Exclude<SentinelVerdict, TerminalSentinel> | PersistenceResult;

const classify = (status: 400 | 403, body: Bytes): SentinelVerdict => {
  if (body.byteLength > TERMINAL_SENTINEL_BYTE_LIMIT) return { kind: 'incomplete', reason: 'byte_limit' };
  const bodyText = body.utf8();
  let parsed: unknown;
  try {
    parsed = JSON.parse(bodyText);
  } catch (error) {
    if (!(error instanceof SyntaxError)) throw error;
    logWarn('claude_code_unparseable_error_body', { status, body_snippet: bodyText.slice(0, 256) });
    return { kind: 'not-terminal' };
  }
  if (typeof parsed !== 'object' || parsed === null) return { kind: 'not-terminal' };
  const error = (parsed as AnthropicErrorBody).error;
  if (typeof error !== 'object' || error === null) return { kind: 'not-terminal' };
  const { type, message } = error;
  if (typeof type !== 'string' || typeof message !== 'string') return { kind: 'not-terminal' };
  const lowered = message.toLowerCase();
  if (status === 400 && type === 'invalid_request_error' && lowered.includes(ORG_DISABLED_400_SENTINEL)) {
    return {
      kind: 'terminal', status, reason: 'org_disabled_400_sentinel',
      message: `Organization disabled by Anthropic — re-import will not recover; contact support: ${message}`,
    };
  }
  if (status === 403 && type === 'permission_error' && lowered.includes(ORG_BANNED_403_SENTINEL)) {
    return {
      kind: 'terminal', status, reason: 'org_banned_403_sentinel',
      message: `Organization banned from OAuth by Anthropic — re-import will not recover; contact support: ${message}`,
    };
  }
  return { kind: 'not-terminal' };
};

const drain = async (
  inner: ReleasingInner<HttpResponseBodyChunk>,
  observe: (chunk: Bytes) => boolean,
): Promise<'complete' | 'byte_limit' | 'deadline' | TransportFailure> => {
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
      if (isTransportFailure(part.value)) return part.value;
      if (!observe(part.value)) return 'byte_limit';
    }
  } finally {
    clearTimeout(timer);
  }
};

export const observeTerminalSentinel = (
  upstreamId: string,
  response: HttpResponseFacts,
  scope: Scope<ClaudeCodeServices>,
): HttpResponseFacts => {
  const { status, body } = response;
  if (status !== 400 && status !== 403) return response;
  const fields = { upstream_id: upstreamId, upstream_status: status };
  const persist = async (verdict: SentinelVerdict): Promise<SentinelResult> => {
    if (verdict.kind !== 'terminal') return verdict;
    scope.log.warn('claude_code_terminal_sentinel_detected', { ...fields, reason: verdict.reason });
    const result = await scope.services.claudeCode.persistTerminalVerdict(upstreamId, verdict);
    if (!result.persisted) {
      scope.log.warn('claude_code_terminal_sentinel_persist_failed', { ...fields, error: `${result.error.name}: ${result.error.message}` });
    }
    return result;
  };
  if (body === null || body instanceof Bytes) {
    scope.defer('claude-code.terminal-sentinel', persist(classify(status, body ?? Bytes.empty)));
    return response;
  }

  let length = 0;
  let overLimit = false;
  let sawTransportFailure: ErrorSnapshot | undefined;
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
  const finish = (): SentinelVerdict => classify(status, Bytes.concat(parts));
  const unreadable = (error: ErrorSnapshot): SentinelVerdict => {
    const details = { ...fields, error: `${error.name}: ${error.message}` };
    logWarn('claude_code_terminal_sentinel_body_read_failed', details);
    scope.log.warn('claude_code_terminal_sentinel_body_read_failed', details);
    return { kind: 'unreadable', error };
  };
  const closeVerdict = async (end: StreamEnd, inner: ReleasingInner<HttpResponseBodyChunk> | null): Promise<SentinelVerdict> => {
    if (end.how === 'errored') throw end.error;
    if (sawTransportFailure !== undefined) return unreadable(sawTransportFailure);
    if (overLimit) return { kind: 'incomplete', reason: 'byte_limit' };
    if (end.how === 'exhausted') return finish();
    if (end.how !== 'released' || inner === null) return { kind: 'incomplete', reason: end.how };

    const drained = await drain(inner, observe);
    if (isTransportFailure(drained)) return unreadable(drained.error);
    if (scope.signal.aborted) return { kind: 'incomplete', reason: 'cancelled' };
    return drained === 'complete' ? finish() : { kind: 'incomplete', reason: drained };
  };
  const forwarded = scope.wrapStream(body, {
    label: 'claude-code.terminal-sentinel',
    async *transform(source) {
      for await (const part of source) {
        if (isTransportFailure(part)) sawTransportFailure = part.error;
        else observe(part);
        yield part;
      }
    },
    onClose: (end, inner): Promise<void> => closeVerdict(end, inner).then(
      verdict.resolve,
      error => {
        verdict.reject(error);
        throw error;
      },
    ),
  });
  const verdict = scope.deferred<SentinelVerdict>('claude-code.terminal-sentinel.verdict', forwarded);
  scope.defer('claude-code.terminal-sentinel', verdict.deferred.promise.then(persist));
  return { ...response, body: forwarded };
};
