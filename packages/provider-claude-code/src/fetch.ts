import { ensureClaudeCodeAccessToken, invalidateClaudeCodeAccessToken, type EnsuredAccessToken } from './access-token-cache.ts';
import { ClaudeCodeOAuthSessionTerminatedError } from './auth/oauth.ts';
import { pickClaudeCodeHeaders } from './headers.ts';
import { logWarn, logInfo } from './log.ts';
import { parseClaudeCodeQuotaHeaders, type ClaudeCodeQuotaSnapshot } from './quota.ts';
import {
  readClaudeCodeUpstreamState,
  replaceSoleAccount,
} from './state.ts';
import type { ClaudeCodeProviderData } from './types.ts';
import type { MessagesPayload, MessagesStreamEvent } from '@floway-dev/protocols/messages';
import { parseMessagesStream } from '@floway-dev/protocols/messages';
import {
  getProviderRepo,
  streamingProviderCall,
  type ProviderModel,
  type ProviderStreamResult,
  type UpstreamCallOptions,
} from '@floway-dev/provider';

const ANTHROPIC_MESSAGES_ENDPOINT = 'https://api.anthropic.com/v1/messages?beta=true';

// Detection helper: the periodic CC connectivity probe sends `max_tokens: 1`
// against a haiku id (model name substring 'haiku') and never carries a
// system block. Surfacing those as CC-shaped lets them pass through without
// re-mimicry overhead, matching real CC's wire shape exactly.
export const detectHaikuProbe = (body: { model?: unknown; max_tokens?: unknown }): boolean => {
  return typeof body.model === 'string'
    && body.model.includes('haiku')
    && body.max_tokens === 1;
};

export interface CallClaudeCodeMessagesOptions {
  upstreamId: string;
  model: ProviderModel;
  body: Omit<MessagesPayload, 'model'>;
  // `shaped: true` means the inbound request already looks like real CC
  // traffic (operator's CC client sent through verbatim). The wire header
  // surface is rebuilt from `opts.call.headers` through a tight
  // whitelist that matches sub2api's `allowedHeaders`
  // (gateway_service.go:422-444), preserving the operator's genuine
  // X-Stainless-* / anthropic-beta / x-claude-code-session-id fingerprint
  // end-to-end. Only Authorization is swapped for our cached OAuth token.
  // `shaped: false` means the gateway's re-mimicry chain rebuilt the
  // payload's system blocks / metadata / model id — replace headers with
  // the pinned CC set so the wire shape matches end-to-end.
  shaped: boolean;
  signal?: AbortSignal;
  call: UpstreamCallOptions;
}

// Sub2api's `allowedHeaders` allowlist verbatim
// (gateway_service.go:422-444). On the shaped passthrough path we only
// forward inbound headers whose lowercased name appears here; everything
// else (e.g. ad-hoc debug headers, `host`, `cookie`) is dropped before
// hitting Anthropic. `authorization` is intentionally excluded — we set
// our own from the cached OAuth token. `content-type` is forwarded when
// the inbound carries one; the call site defaults it to
// `application/json` otherwise.
const SHAPED_PASSTHROUGH_HEADER_ALLOWLIST = new Set<string>([
  'accept',
  'x-stainless-retry-count',
  'x-stainless-timeout',
  'x-stainless-lang',
  'x-stainless-package-version',
  'x-stainless-os',
  'x-stainless-arch',
  'x-stainless-runtime',
  'x-stainless-runtime-version',
  'x-stainless-helper-method',
  'anthropic-dangerous-direct-browser-access',
  'anthropic-version',
  'x-app',
  'anthropic-beta',
  'accept-language',
  'sec-fetch-mode',
  'user-agent',
  'content-type',
  'accept-encoding',
  'x-claude-code-session-id',
  'x-client-request-id',
]);

const synthetic503 = (message: string): Response =>
  new Response(
    JSON.stringify({ error: { type: 'claude_code_upstream_unavailable', message } }),
    { status: 503, headers: { 'content-type': 'application/json' } },
  );

const synthetic429 = (message: string, retryAtIso: string | null, now: Date): Response => {
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
const isRateLimitedNow = (
  snapshot: ClaudeCodeQuotaSnapshot | null,
  now: Date,
): snapshot is ClaudeCodeQuotaSnapshot => {
  if (!snapshot) return false;
  if (snapshot.status !== 'rejected') return false;
  if (!snapshot.reset) return false;
  return new Date(snapshot.reset).getTime() > now.getTime();
};

const persistQuotaSnapshot = async (upstreamId: string, snapshot: ClaudeCodeQuotaSnapshot): Promise<void> => {
  const fresh = await getProviderRepo().upstreams.getById(upstreamId);
  if (!fresh) throw new Error(`Claude Code upstream ${upstreamId} disappeared mid-request`);
  const state = readClaudeCodeUpstreamState(fresh.state);
  const account = state.accounts[0];
  const priorStatus = account.quotaSnapshot === null ? null : account.quotaSnapshot.data.status;
  const next = replaceSoleAccount(state, account => ({
    ...account,
    quotaSnapshot: { fetchedAt: Date.now(), data: snapshot },
  }));
  await getProviderRepo().upstreams.saveState(upstreamId, next, { expectedState: fresh.state });
  // Emit only on transition. Persisting every response would flood the log
  // with one event per request; the dashboard already reads the snapshot
  // verbatim. Operators care about the moment the upstream flipped from
  // `allowed` to `rejected` (or back), not the steady state.
  if (priorStatus !== snapshot.status) {
    logInfo('claude_code_quota_state_transition', {
      upstream_id: upstreamId,
      account_uuid: account.accountUuid,
      from_status: priorStatus,
      to_status: snapshot.status,
      reset_at_iso: snapshot.reset,
      representative_claim: snapshot.representativeClaim,
    });
  }
};

// Best-effort persist: a CAS loss to a concurrent rotation or quota write is
// fine because the live state already carries a snapshot at least as fresh
// as the one we'd write. The hot path must not block on the write completing
// or surface its failures to the caller. Skip writing when the response
// carries no rate-limit signal at all — that would erase the prior snapshot
// for no upside.
//
// On Cloudflare Workers the runtime cancels orphan promises the moment the
// response is sent to the client, so a bare fire-and-forget would lose the
// write on the hot path. The `waitUntil` callback (when supplied by the
// gateway) extends the worker's lifetime past the response so the persist
// completes. When `waitUntil` is undefined (Node target / tests), the
// promise still runs to completion under the host event loop
// — and tests can observe it by awaiting a microtask flush.
const persistQuotaFromHeadersFireAndForget = (
  upstreamId: string,
  headers: Headers,
  waitUntil: ((promise: Promise<unknown>) => void) | undefined,
): void => {
  const snapshot = parseClaudeCodeQuotaHeaders(headers);
  if (Object.keys(snapshot.raw).length === 0) return;
  const persist = persistQuotaSnapshot(upstreamId, snapshot).catch(error => {
    logWarn('claude_code_quota_persist_failed', {
      upstream_id: upstreamId,
      error: String(error),
    });
  });
  waitUntil?.(persist);
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

// Terminal flip from the data-plane sentinel detector. Distinct from
// access-token-cache.ts's `persistTerminalState`: this path runs in a
// fire-and-forget context with no caller-side state, so we re-read; the
// flip is body-sentinel-triggered (org disabled/banned), not oauth-error-
// triggered, so the log carries `upstream_status` instead of `oauth_code`;
// and a sibling oauth-side flip may have already happened, so we skip the
// write when the account isn't `active` anymore. Merging the two helpers
// would force conditional dispatch on every one of these axes.
const persistTerminalAccountState = async (
  upstreamId: string,
  terminalMessage: string,
  reason: string,
  upstreamStatus: number,
): Promise<void> => {
  const fresh = await getProviderRepo().upstreams.getById(upstreamId);
  if (!fresh) return;
  const state = readClaudeCodeUpstreamState(fresh.state);
  const account = state.accounts[0];
  // Already terminal — a sibling write (e.g. an OAuth refresh death) won;
  // skip overwriting the prior message so the dashboard keeps the first
  // signal.
  if (account.state !== 'active') return;
  const flipped = replaceSoleAccount(state, account => ({
    ...account,
    state: 'refresh_failed',
    stateMessage: terminalMessage,
    stateUpdatedAt: new Date().toISOString(),
    accessToken: null,
  }));
  await getProviderRepo().upstreams.saveState(upstreamId, flipped, { expectedState: fresh.state });
  logWarn('claude_code_account_state_flip', {
    upstream_id: upstreamId,
    account_uuid: account.accountUuid,
    from_state: account.state,
    to_state: 'refresh_failed',
    reason,
    upstream_status: upstreamStatus,
    message: terminalMessage,
  });
};

// Fire-and-forget: clones the response so the original body still streams
// to the caller intact (we surface upstream verbatim — the terminal flip
// is purely additional dashboard signal). CAS loss to a concurrent
// rotation is fine: either the sibling already flipped to terminal (no
// regression) or the sibling rotated state and the next request
// re-detects the sentinel.
//
// Same lifecycle dance as `persistQuotaFromHeadersFireAndForget`: under
// Workers the runtime cancels orphan promises the moment the response is
// sent, so we register the persist with `waitUntil` when the gateway
// supplied it.
const maybePersistTerminalFromBodyFireAndForget = (
  upstreamId: string,
  response: Response,
  waitUntil: ((promise: Promise<unknown>) => void) | undefined,
): void => {
  if (response.status !== 400 && response.status !== 403) return;
  const cloned = response.clone();
  const task = (async () => {
    let bodyText: string;
    try {
      bodyText = await cloned.text();
    } catch (error) {
      logWarn('claude_code_terminal_sentinel_body_read_failed', {
        upstream_id: upstreamId,
        upstream_status: response.status,
        error: String(error),
      });
      return;
    }
    const terminalMessage = detectTerminalSentinel(response.status, bodyText);
    if (terminalMessage === null) return;
    const reason = response.status === 400 ? 'org_disabled_400_sentinel' : 'org_banned_403_sentinel';
    logWarn('claude_code_terminal_sentinel_detected', {
      upstream_id: upstreamId,
      upstream_status: response.status,
      reason,
    });
    await persistTerminalAccountState(upstreamId, terminalMessage, reason, response.status);
  })().catch(error => {
    logWarn('claude_code_terminal_sentinel_persist_failed', {
      upstream_id: upstreamId,
      error: String(error),
    });
  });
  waitUntil?.(task);
};

// recordUpstreamLatency contract: every code path that returns must wrap
// exactly one fetch (real or synthetic). Synthetic gates ride a resolved
// promise so the gateway's recorder sees the contract met without
// measuring anything meaningful. Both the pre-flight gates and the 401-retry
// terminal-state branch use this helper so the two paths read identically;
// the recorder's "at least once + last wrap kept" contract is satisfied
// even when the streaming call already wrapped its own fetch upstream of
// the retry.
const syntheticReturn = async (
  opts: CallClaudeCodeMessagesOptions,
  upstreamModelId: string,
  response: Response,
): Promise<ProviderStreamResult<MessagesStreamEvent>> => ({
  ok: false,
  modelKey: upstreamModelId,
  response: await opts.call.recordUpstreamLatency(Promise.resolve(response)),
});

// Either ensures a usable access token or returns a 503 wrap for terminal
// refresh failures; other errors propagate. Used at both the cold-start
// call site and the 401-retry branch so the catch shape lives in one place.
const ensureOrSession503 = async (
  opts: CallClaudeCodeMessagesOptions,
  upstreamModelId: string,
): Promise<EnsuredAccessToken | ProviderStreamResult<MessagesStreamEvent>> => {
  try {
    return await ensureClaudeCodeAccessToken({
      upstreamId: opts.upstreamId,
      repo: getProviderRepo().upstreams,
      fetcher: opts.call.fetcher,
    });
  } catch (err) {
    if (err instanceof ClaudeCodeOAuthSessionTerminatedError) {
      // ensureClaudeCodeAccessToken already persisted the terminal state.
      return await syntheticReturn(opts, upstreamModelId, synthetic503(`Claude Code refresh failed: ${err.upstreamMessage}`));
    }
    throw err;
  }
};

export const callClaudeCodeMessages = async (
  opts: CallClaudeCodeMessagesOptions,
): Promise<ProviderStreamResult<MessagesStreamEvent>> => {
  // `opts.model.id` is the public alias on the catalog; the dated upstream id
  // Anthropic expects on the wire — and that the pricing table keys by — rides
  // on `opts.model.providerData.upstreamModelId`. Resolve once so synthetic
  // gates, the wire body, and the streaming-call modelKey all surface the
  // same dated id.
  const upstreamModelId = (opts.model.providerData as ClaudeCodeProviderData).upstreamModelId;

  const fresh = await getProviderRepo().upstreams.getById(opts.upstreamId);
  if (!fresh) throw new Error(`Claude Code upstream ${opts.upstreamId} disappeared mid-request`);
  const state = readClaudeCodeUpstreamState(fresh.state);
  const account = state.accounts[0];

  if (account.state !== 'active') {
    return await syntheticReturn(opts, upstreamModelId, synthetic503(
      `Claude Code account is ${account.state}: ${account.stateMessage}`,
    ));
  }

  const now = new Date();
  const quotaData = account.quotaSnapshot === null ? null : account.quotaSnapshot.data;
  if (isRateLimitedNow(quotaData, now)) {
    const resetIso = quotaData.reset;
    return await syntheticReturn(opts, upstreamModelId, synthetic429(
      resetIso ? `Claude Code upstream rate-limited until ${resetIso}` : 'Claude Code upstream rate-limited',
      resetIso,
      now,
    ));
  }

  const ensured = await ensureOrSession503(opts, upstreamModelId);
  if ('modelKey' in ensured) return ensured;

  return await performUpstreamCall(opts, upstreamModelId, ensured, false);
};

const performUpstreamCall = async (
  opts: CallClaudeCodeMessagesOptions,
  upstreamModelId: string,
  accessToken: EnsuredAccessToken,
  alreadyRetried: boolean,
): Promise<ProviderStreamResult<MessagesStreamEvent>> => {
  let headers: Record<string, string>;
  if (opts.shaped) {
    // Shaped path: forward the operator's inbound CC fingerprint through a
    // tight whitelist (see SHAPED_PASSTHROUGH_HEADER_ALLOWLIST). `opts.call.headers`
    // is always present per the UpstreamCallOptions contract; an empty bag
    // still produces a working passthrough (just content-type + authorization).
    const inbound = opts.call.headers;
    const passthrough: Record<string, string> = {};
    for (const [name, value] of inbound.entries()) {
      if (SHAPED_PASSTHROUGH_HEADER_ALLOWLIST.has(name)) passthrough[name] = value;
    }
    // Sub2api always sets Content-Type when the inbound omits it
    // (`gateway_service.go` request-forwarding path), so the upstream
    // never receives a body-bearing request without a media type.
    if (!('content-type' in passthrough)) passthrough['content-type'] = 'application/json';
    headers = { ...passthrough, authorization: `Bearer ${accessToken.entry.token}` };
  } else {
    headers = { ...pickClaudeCodeHeaders(upstreamModelId), authorization: `Bearer ${accessToken.entry.token}` };
  }

  // Force stream:true regardless of caller intent. The streaming envelope is
  // what the gateway boundary expects; non-streaming Messages is routed
  // elsewhere. Safe in the shaped passthrough path too: shaped detection
  // requires CC client headers + system blocks + a valid metadata.user_id,
  // and the real Claude Code client always sets `stream: true`.
  const wireBody: MessagesPayload = { ...opts.body, model: upstreamModelId, stream: true };

  const upstreamFetch = opts.call.fetcher(ANTHROPIC_MESSAGES_ENDPOINT, {
    method: 'POST',
    headers,
    body: JSON.stringify(wireBody),
    signal: opts.signal,
  }, opts.call.recordUpstreamLatency).then(response => {
    // `opts.call.waitUntil` is set by the gateway on Workers so the
    // runtime keeps the worker alive past the response (without it, the
    // persist promise gets cancelled the moment the response returns).
    // Undefined under hosts that don't supply it (Node target / tests).
    const { waitUntil } = opts.call;
    // Every Anthropic response (2xx or 429) ships an
    // `anthropic-ratelimit-unified-*` snapshot; capture both so the rate-
    // limited gate above stays accurate as the window evolves. Other
    // statuses (4xx/5xx outside 429) carry no quota signal so we skip them.
    if (response.ok || response.status === 429) {
      persistQuotaFromHeadersFireAndForget(opts.upstreamId, response.headers, waitUntil);
    }
    // 400 / 403 may carry the credential-class terminal sentinels — the
    // detector is body-shape-defensive and only flips on a real match, so
    // unrelated 400s (`max_tokens` validation, etc.) pass straight through.
    maybePersistTerminalFromBodyFireAndForget(opts.upstreamId, response, waitUntil);
    return response;
  });

  const result = await streamingProviderCall(upstreamFetch, parseMessagesStream, upstreamModelId, opts.signal);

  if (!result.ok && result.response.status === 401 && !accessToken.freshlyMinted && !alreadyRetried) {
    // Cached token rejected; invalidate so the next mint reads stale=null,
    // then re-enter with a fresh-minted token. A second 401 (alreadyRetried
    // == true) means the refresh_token itself is the problem and the
    // operator has to re-import — surface the 401 verbatim so the gateway
    // boundary reports the real upstream message rather than masking it.
    await invalidateClaudeCodeAccessToken({
      upstreamId: opts.upstreamId,
      repo: getProviderRepo().upstreams,
    });
    const ensured = await ensureOrSession503(opts, upstreamModelId);
    // If the refresh terminated, ensureOrSession503 returns a syntheticReturn
    // wrap. That wrap intentionally shadows the failed first fetch's recorded
    // latency under the "last wrap wins" semantics — the telemetry surface
    // reflects the synthetic 503 because that is what the caller sees, not the
    // 401 we discarded.
    if ('modelKey' in ensured) return ensured;
    return await performUpstreamCall(opts, upstreamModelId, ensured, true);
  }

  return result;
};
