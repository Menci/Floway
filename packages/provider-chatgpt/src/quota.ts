import { isUnsafeObjectKey } from './auth/guards.ts';
import type { ChatGPTQuotaSnapshot } from './state.ts';

export const CHATGPT_QUOTA_UNKNOWN_ACTIVE_LIMIT = 'unknown';

export const chatgptQuotaActiveLimitKey = (snapshot: ChatGPTQuotaSnapshot): string => {
  const key = snapshot.active_limit?.trim();
  return key && !isUnsafeObjectKey(key) ? key : CHATGPT_QUOTA_UNKNOWN_ACTIVE_LIMIT;
};

// Each window has independent usage and optional reset metadata.
// https://github.com/openai/codex/blob/602d2add6e6df7e2c301c0507434b02a7463337d/codex-rs/codex-api/src/rate_limits.rs
// This is the latest KNOWN timed quota restriction, not a recovery guarantee:
// an exhausted window without a reset remains in the snapshot but cannot date it.
const chatgptQuotaRestrictionUntil = (snapshot: ChatGPTQuotaSnapshot): string | undefined => {
  const horizons = [
    [snapshot.primary_used_percent, snapshot.primary_reset_after_at],
    [snapshot.secondary_used_percent, snapshot.secondary_reset_after_at],
  ] as const;
  const resets = horizons.flatMap(([used, reset]) => {
    if (used === undefined || !Number.isFinite(used) || used < 100 || reset === undefined) return [];
    const instant = Date.parse(reset);
    return Number.isFinite(instant) && instant > 0 ? [instant] : [];
  });
  return resets.length > 0 ? new Date(Math.max(...resets)).toISOString() : undefined;
};

export const projectChatGPTQuota = (snapshot: ChatGPTQuotaSnapshot): ChatGPTQuotaSnapshot => {
  if (snapshot.ratelimited_until === undefined) return snapshot;
  const { ratelimited_until: _legacyUntil, ...reading } = snapshot;
  const until = chatgptQuotaRestrictionUntil(reading);
  return until === undefined ? reading : { ...reading, ratelimited_until: until };
};

interface ParseChatGPTQuotaOptions {
  now: Date;
  isRateLimited: boolean;
}

export const parseChatGPTQuotaHeaders = (headers: Headers, options: ParseChatGPTQuotaOptions): ChatGPTQuotaSnapshot => {
  const snapshot: ChatGPTQuotaSnapshot = { observed_at: options.now.toISOString() };
  const assign = snapshot as unknown as Record<string, unknown>;

  const setString = (key: keyof ChatGPTQuotaSnapshot, header: string): void => {
    const v = headers.get(header);
    if (v === null) return;
    const trimmed = v.trim();
    if (trimmed !== '') assign[key] = trimmed;
  };
  const setNumber = (key: keyof ChatGPTQuotaSnapshot, header: string): void => {
    const v = headers.get(header);
    if (v === null) return;
    // Blank rather than absent is how this backend reports a field that does
    // not apply -- a plan with no secondary window, an account with no credit
    // balance -- and `Number('')` is 0, which would render as a confident zero.
    if (v.trim() === '') return;
    const n = Number(v);
    if (Number.isFinite(n)) assign[key] = n;
  };
  const setBool = (key: keyof ChatGPTQuotaSnapshot, header: string): void => {
    const v = headers.get(header);
    if (v === null) return;
    const lower = v.toLowerCase();
    if (lower === 'true') assign[key] = true;
    else if (lower === 'false') assign[key] = false;
  };
  // Upstream renamed this reading on 2025-10-17: `-reset-at` states the instant
  // outright, where `-reset-after-seconds` states the offset from receipt. Both
  // are still sent, and a capture from 2025-09 carries only the offset, so the
  // rename added a header rather than replacing one. The instant is preferred
  // and the offset is the fallback, which is the shape the third-party clients
  // that read both settled on -- and which keeps this working on the day the
  // offset stops being sent.
  // https://github.com/openai/codex/commit/0e08dd605
  //
  // Zero and blank both mean "this plan has no such window" rather than "it
  // resets now": a capture pairs a blank `-reset-at` with a zero
  // `-reset-after-seconds` on a plan whose secondary window is 0 minutes wide.
  const resetInstant = (prefix: string): string | undefined => {
    const at = headers.get(`${prefix}-reset-at`)?.trim();
    if (at !== undefined && at !== '') {
      const epochSeconds = Number(at);
      // Epoch seconds today; RFC 3339 in builds from the three days after the
      // header landed, which is why clients that read it accept both.
      const instant = Number.isFinite(epochSeconds) ? epochSeconds * 1000 : Date.parse(at);
      if (Number.isFinite(instant) && instant > 0) return new Date(instant).toISOString();
    }
    const after = headers.get(`${prefix}-reset-after-seconds`)?.trim();
    if (after === undefined || after === '') return undefined;
    const seconds = Number(after);
    if (!Number.isFinite(seconds) || seconds <= 0) return undefined;
    return new Date(options.now.getTime() + seconds * 1000).toISOString();
  };

  const setReset = (key: keyof ChatGPTQuotaSnapshot, prefix: string): void => {
    const instant = resetInstant(prefix);
    if (instant !== undefined) assign[key] = instant;
  };

  setString('active_limit', 'x-codex-active-limit');
  setString('plan_type', 'x-codex-plan-type');
  setNumber('primary_used_percent', 'x-codex-primary-used-percent');
  setNumber('primary_window_minutes', 'x-codex-primary-window-minutes');
  setReset('primary_reset_after_at', 'x-codex-primary');
  setNumber('secondary_used_percent', 'x-codex-secondary-used-percent');
  setNumber('secondary_window_minutes', 'x-codex-secondary-window-minutes');
  setReset('secondary_reset_after_at', 'x-codex-secondary');
  setBool('credits_has_credits', 'x-codex-credits-has-credits');
  setNumber('credits_balance', 'x-codex-credits-balance');

  if (options.isRateLimited) {
    const until = chatgptQuotaRestrictionUntil(snapshot);
    if (until !== undefined) snapshot.ratelimited_until = until;
  }

  return snapshot;
};

export const hasChatGPTQuotaReading = (snapshot: ChatGPTQuotaSnapshot): boolean => {
  const { observed_at: _observationTime, ...reading } = snapshot;
  return Object.keys(reading).length > 0;
};
