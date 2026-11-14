import { ensureChatGPTAccessToken, mintChatGPTAccessToken } from './access-token.ts';
import { ChatGPTOAuthSessionTerminatedError } from './auth/oauth.ts';
import { assertChatGPTUpstreamRecord } from './config.ts';
import { CHATGPT_BACKEND_BASE, CHATGPT_USER_AGENT } from './constants.ts';
import { putChatGPTQuota } from './quota.ts';
import { readChatGPTUpstreamState, persistChatGPTRefreshTokenRotation, persistChatGPTTerminalState, type ChatGPTQuotaSnapshot } from './state.ts';
import { runScheduledUsageRefresh, type ProviderScheduledOptions, type UpstreamRecord } from '@floway-dev/provider';

// https://github.com/openai/codex/blob/1badea29abf49e56530a778ac3bb2d3da3bc4d5e/codex-rs/backend-client/src/client/rate_limit_resets.rs#L148-L153
const CHATGPT_USAGE_PATH = '/wham/usage';

const responseObject = (value: unknown): Record<string, unknown> => {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) throw new TypeError('ChatGPT usage response must contain an object');
  return value as Record<string, unknown>;
};

const finiteNumber = (value: unknown): number => {
  if (typeof value !== 'number' || !Number.isFinite(value)) throw new TypeError('ChatGPT usage response must contain a finite number');
  return value;
};

// Bucket ids and nullable windows follow the official backend projection.
// https://github.com/openai/codex/blob/1badea29abf49e56530a778ac3bb2d3da3bc4d5e/codex-rs/backend-client/src/client.rs#L612-L657
export const parseChatGPTUsage = (value: unknown, now: Date): ChatGPTQuotaSnapshot[] => {
  const body = responseObject(value);
  const project = (id: string, rawLimits: unknown, credits: unknown): ChatGPTQuotaSnapshot => {
    const snapshot: ChatGPTQuotaSnapshot = { observed_at: now.toISOString(), active_limit: id };
    if (body.plan_type !== undefined) {
      if (typeof body.plan_type !== 'string') throw new TypeError('ChatGPT usage plan_type must be a string');
      snapshot.plan_type = body.plan_type;
    }
    if (rawLimits !== undefined && rawLimits !== null) {
      const limits = responseObject(rawLimits);
      for (const key of ['primary', 'secondary'] as const) {
        const rawWindow = limits[`${key}_window`];
        if (rawWindow === undefined || rawWindow === null) continue;
        const window = responseObject(rawWindow);
        snapshot[`${key}_used_percent`] = finiteNumber(window.used_percent);
        snapshot[`${key}_window_minutes`] = finiteNumber(window.limit_window_seconds) / 60;
        snapshot[`${key}_reset_after_at`] = new Date(finiteNumber(window.reset_at) * 1000).toISOString();
      }
    }
    if (credits !== undefined && credits !== null) {
      const credit = responseObject(credits);
      if (credit.has_credits !== undefined) {
        if (typeof credit.has_credits !== 'boolean') throw new TypeError('ChatGPT usage has_credits must be a boolean');
        snapshot.credits_has_credits = credit.has_credits;
      }
      if (credit.balance !== undefined && credit.balance !== null) {
        const balance = typeof credit.balance === 'string' && credit.balance.trim() !== '' ? Number(credit.balance) : credit.balance;
        snapshot.credits_balance = finiteNumber(balance);
      }
    }
    return snapshot;
  };
  const snapshots = [project('codex', body.rate_limit, body.credits)];
  if (body.additional_rate_limits !== undefined && body.additional_rate_limits !== null) {
    if (!Array.isArray(body.additional_rate_limits)) throw new TypeError('ChatGPT additional_rate_limits must be an array');
    for (const raw of body.additional_rate_limits) {
      const entry = responseObject(raw);
      if (typeof entry.metered_feature !== 'string' || entry.metered_feature === '') throw new TypeError('ChatGPT metered_feature must be a non-empty string');
      snapshots.push(project(entry.metered_feature, entry.rate_limit, null));
    }
  }
  return snapshots;
};

export const runChatGPTScheduledTask = async (record: UpstreamRecord, options: ProviderScheduledOptions): Promise<void> => {
  const account = readChatGPTUpstreamState(record.state).accounts[0];
  if (account.state !== 'active') return;
  const observations = Object.values(account.quotaSnapshot ?? {}).map(snapshot => snapshot.fetchedAt);
  await runScheduledUsageRefresh(record, options, observations.length === 0 ? null : Math.min(...observations), async (fresh, fetcher) => {
    assertChatGPTUpstreamRecord(fresh);
    const accountId = fresh.config.accounts[0].chatgptAccountId;
    let access;
    try {
      access = await ensureChatGPTAccessToken(fresh.id, accountId, refreshToken => mintChatGPTAccessToken(refreshToken, fetcher,
        token => persistChatGPTRefreshTokenRotation(fresh.id, accountId, token)));
    } catch (error) {
      if (error instanceof ChatGPTOAuthSessionTerminatedError) await persistChatGPTTerminalState(fresh.id, accountId, 'refresh_failed', error.upstreamMessage, { onMissing: 'throw' });
      throw error;
    }
    const response = await fetcher(`${CHATGPT_BACKEND_BASE}${CHATGPT_USAGE_PATH}`, {
      method: 'GET',
      headers: {
        authorization: `Bearer ${access.token}`,
        ...(accountId === null ? {} : { 'chatgpt-account-id': accountId }),
        'user-agent': CHATGPT_USER_AGENT,
        accept: 'application/json',
      },
    });
    if (!response.ok) throw new Error(`ChatGPT usage returned ${response.status}: ${(await response.text()).slice(0, 256)}`);
    const snapshots = parseChatGPTUsage(await response.json(), new Date());
    for (const snapshot of snapshots) await putChatGPTQuota(fresh.id, accountId, snapshot);
  });
};
