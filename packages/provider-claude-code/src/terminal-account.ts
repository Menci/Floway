import { logWarn } from './log.ts';
import { readClaudeCodeUpstreamState, replaceSoleAccount, type ClaudeCodeAccountCredential } from './state.ts';
import { getProviderRepo } from '@floway-dev/provider';

// Both sentinels identify a permanently disabled organization. The shortened
// text matches sub2api's detection while also accepting Claude Relay Service's
// longer wording; unrelated 400 and 403 bodies remain ordinary upstream errors.
const ORG_DISABLED_400_SENTINEL = 'organization has been disabled';
const ORG_BANNED_403_SENTINEL = 'oauth authentication is currently not allowed';

interface AnthropicErrorBody {
  error?: { type?: unknown; message?: unknown };
}

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
  if (typeof error.type !== 'string' || typeof error.message !== 'string') return null;
  const message = error.message;
  const lowered = message.toLowerCase();
  if (status === 400 && error.type === 'invalid_request_error' && lowered.includes(ORG_DISABLED_400_SENTINEL)) {
    return `Organization disabled by Anthropic; re-import will not recover. Contact support: ${message}`;
  }
  if (status === 403 && error.type === 'permission_error' && lowered.includes(ORG_BANNED_403_SENTINEL)) {
    return `Organization banned from OAuth by Anthropic; re-import will not recover. Contact support: ${message}`;
  }
  return null;
};

export const persistTerminalAccountState = async (
  upstreamId: string,
  terminalMessage: string,
  reason: string,
  upstreamStatus: number,
): Promise<void> => {
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
