import { logWarn, logInfo, type LogFields } from './log.ts';
import { type ClaudeCodeQuotaSnapshot } from './quota.ts';
import {
  readClaudeCodeUpstreamState,
  replaceSoleAccount,
  type ClaudeCodeAccountCredential,
} from './state.ts';
import type { AnthropicMessagesStreamEvent } from '@floway-dev/protocols/anthropic-messages';
import type { ProtocolFrame } from '@floway-dev/protocols/common';
import { getProviderRepo } from '@floway-dev/provider';

export const ANTHROPIC_MESSAGES_ENDPOINT = 'https://api.anthropic.com/v1/messages?beta=true';
export const STREAM_DIAGNOSTIC_FRAME_LIMIT = 3;
export const STREAM_DIAGNOSTIC_FRAME_DATA_CHARS = 256;

export const synthetic503 = (message: string): Response =>
  new Response(
    JSON.stringify({ error: { type: 'claude_code_upstream_unavailable', message } }),
    { status: 503, headers: { 'content-type': 'application/json' } },
  );

export const synthetic429 = (message: string, retryAtIso: string | null, now: Date): Response => {
  const retryAfterSeconds = retryAtIso === null
    ? 60
    : Math.max(0, Math.ceil((new Date(retryAtIso).getTime() - now.getTime()) / 1000));
  return new Response(
    JSON.stringify({ error: { type: 'claude_code_rate_limited', message, retry_at: retryAtIso } }),
    {
      status: 429,
      headers: { 'content-type': 'application/json', 'retry-after': String(retryAfterSeconds) },
    },
  );
};

export interface StreamDiagnosticFrame {
  event: string | null;
  data: string;
}

export const observedClaudeCodeMessagesStream = async function* (
  events: AsyncIterable<ProtocolFrame<AnthropicMessagesStreamEvent>>,
  options: {
    upstreamId: string;
    model: string;
    headers: Headers;
    signal: AbortSignal | undefined;
    frames: StreamDiagnosticFrame[];
    rawFrameCount: () => number;
    warn: (message: string, fields: Readonly<Record<string, unknown>>) => Promise<void>;
  },
): AsyncGenerator<ProtocolFrame<AnthropicMessagesStreamEvent>> {
  let terminalEvent: 'message_stop' | 'error' | null = null;
  let streamError: unknown;
  try {
    for await (const frame of events) {
      if (frame.type === 'event') {
        if (frame.event.type === 'message_stop') terminalEvent = 'message_stop';
        else if (frame.event.type === 'error') terminalEvent = 'error';
      }
      yield frame;
    }
  } catch (error) {
    streamError = error;
    throw error;
  } finally {
    if (!options.signal?.aborted && !(terminalEvent !== null && streamError === undefined)) {
      const fields = {
        upstream_id: options.upstreamId,
        model: options.model,
        request_id: options.headers.get('request-id'),
        cf_ray: options.headers.get('cf-ray'),
        trace_response: options.headers.get('traceresponse'),
        raw_sse_frames: options.rawFrameCount(),
        terminal_event: terminalEvent,
        error: streamError === undefined ? null : streamError,
        last_sse_frames: JSON.stringify(options.frames),
      };
      try { await options.warn('claude_code_messages_stream_incomplete', fields); } catch (recordingError) {
        if (streamError === undefined || recordingError === streamError) throw recordingError;
        throw new AggregateError([streamError, recordingError], 'Claude Code stream failed and recording also failed', { cause: streamError });
      }
    }
  }
};

// `anthropic-ratelimit-unified-status: rejected` paired with a future
// `unified-reset` timestamp means the upstream's primary plan window is
// exhausted and a fresh request would 429 right away; short-circuit at
// the gate so we don't burn an OAuth refresh on a request that has no
// chance.
//
// Note 1: `overage.status: rejected` (typically paired with
// `overage-disabled-reason: out_of_credits`) is NOT a short-circuit
// signal. It only reports that the account has no extra-usage credits
// to spill into once the primary window runs out — which is the steady
// state for any plan-tier account that hasn't bought extra credits, so
// blocking on it would refuse every request to such accounts. The
// primary `status` already reflects whether the upstream will actually
// reject the next request.
//
// Note 2: a primary `status: rejected` WITHOUT a `reset` is treated as
// non-gating. Sub2api `ratelimit_service.go:953-961` flags this exact
// shape as "likely not a real rate limit" (e.g. an "Extra usage required"
// body sentinel) and passes it through verbatim — without a reset we'd
// otherwise lock the account out indefinitely because the next request
// never fires to refresh the snapshot.
export const isRateLimitedNow = (
  snapshot: ClaudeCodeQuotaSnapshot | null,
  now: Date,
): snapshot is ClaudeCodeQuotaSnapshot => {
  if (!snapshot) return false;
  if (snapshot.status !== 'rejected') return false;
  if (!snapshot.reset) return false;
  return new Date(snapshot.reset).getTime() > now.getTime();
};

export const persistQuotaSnapshot = async (upstreamId: string, snapshot: ClaudeCodeQuotaSnapshot, info: (message: string, fields: LogFields) => void | Promise<void> = logInfo): Promise<void> => {
  // Stamped before the write: the mutator is replayed on a lost race and must
  // return the same document each time, and this records when the snapshot was
  // observed rather than which attempt landed it.
  const fetchedAt = Date.now();
  // The prior status comes from the state the mutator was handed: the write is
  // retried against whoever won the row, so only that view describes the
  // snapshot this write actually replaced.
  let previousAccount!: ClaudeCodeAccountCredential;
  await getProviderRepo().upstreams.saveState(upstreamId, current => {
    const state = readClaudeCodeUpstreamState(current);
    previousAccount = state.accounts[0];
    return replaceSoleAccount(state, account => ({
      ...account,
      quotaSnapshot: { fetchedAt, data: snapshot },
    }));
  });
  const priorStatus = previousAccount.quotaSnapshot === null ? null : previousAccount.quotaSnapshot.data.status;
  // Emit only on transition. Persisting every response would flood the log
  // with one event per request; the dashboard already reads the snapshot
  // verbatim. Operators care about the moment the upstream flipped from
  // `allowed` to `rejected` (or back), not the steady state.
  if (priorStatus !== snapshot.status) {
    await info('claude_code_quota_state_transition', {
      upstream_id: upstreamId,
      account_uuid: previousAccount.accountUuid,
      from_status: priorStatus,
      to_status: snapshot.status,
      reset_at_iso: snapshot.reset,
      representative_claim: snapshot.representativeClaim,
    });
  }
};

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
export const detectTerminalSentinel = (status: number, bodyText: string): string | null => {
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

// Terminal flip from the data-plane sentinel detector. Distinct from
// access-token.ts's `persistTerminalState`: this path runs in a
// deferred response-observation context, so the account it logs
// comes from the mutator's own view; the flip is body-sentinel-triggered (org
// disabled/banned), not oauth-error-triggered, so the log carries
// `upstream_status` instead of `oauth_code`; and a sibling oauth-side flip may
// have already happened, so an account that is no longer `active` is returned
// untouched — the repo reads that as "nothing to do" and the dashboard keeps
// the first signal. Merging the two helpers would force conditional dispatch
// on every one of these axes.
export const persistTerminalAccountState = async (
  upstreamId: string,
  terminalMessage: string,
  reason: string,
  upstreamStatus: number,
  warn: (message: string, fields: LogFields) => void | Promise<void> = logWarn,
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
  await warn('claude_code_account_state_flip', {
    upstream_id: upstreamId,
    account_uuid: previousAccount.accountUuid,
    from_state: previousAccount.state,
    to_state: 'refresh_failed',
    reason,
    upstream_status: upstreamStatus,
    message: terminalMessage,
  });
};
