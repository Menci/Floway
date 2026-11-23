import { ChatGPTAccessOnlyCredentialError, chatgptAccessTokenFromRefresh, chatgptPlanObservation, isAccessTokenUsable, mergeChatGPTAccessTokenEntry, type ChatGPTPlanObservation } from './access-token.ts';
import { ChatGPTOAuthResponseError, ChatGPTOAuthSessionTerminatedError, refreshChatGPTAccessToken } from './auth/oauth.ts';
import { toChatGPTUpstreamFacts, type ChatGPTUpstreamFacts } from './config.ts';
import { chatgptPlanSupportsImages } from './models.ts';
import { chatgptQuotaActiveLimitKey, hasChatGPTQuotaReading, parseChatGPTQuotaHeaders, projectChatGPTQuota } from './quota.ts';
import { findChatGPTAccountIndex, readChatGPTUpstreamState, replaceChatGPTAccount, type ChatGPTAccessTokenEntry, type ChatGPTAccountCredential, type ChatGPTQuotaSnapshot, type ChatGPTQuotaSnapshotMap } from './state.ts';
import { chatgptMetrics } from './upstream-metrics.ts';
import { fetchChatGPTUsage } from './usage-probe.ts';
import { secret, snapshotError, type ErrorSnapshot, type Secret } from '@floway-dev/pipeline';
import { getProviderRepo, isUpstreamTransportError, recordUpstreamMetrics, runScheduledUsageRefresh, UpstreamGoneError, type Fetcher, type ProviderScheduledOptions, type ProviderServices } from '@floway-dev/provider';

type AccountId = string | null;
type Mint = (refreshToken: string) => Promise<ChatGPTAccessTokenEntry>;
type RefreshMint = (refreshToken: string) => Promise<{ readonly entry: ChatGPTAccessTokenEntry; readonly rotatedToken?: string }>;
type RefreshResult =
  | { readonly kind: 'token'; readonly entry: ChatGPTAccessTokenEntry }
  | { readonly kind: 'terminal'; readonly error: ChatGPTOAuthSessionTerminatedError; readonly refreshToken: string };
type TerminalState = 'session_terminated' | 'refresh_failed';
type MissingAccountOptions = { readonly onMissing: 'noop' | 'throw' };
export type ChatGPTPersistence = { readonly persisted: true } | { readonly persisted: false; readonly error: ErrorSnapshot };

interface AccessRequest {
  readonly upstream: ChatGPTUpstreamFacts;
  readonly fetcher: Fetcher;
  readonly now: number;
  readonly signal?: AbortSignal;
  readonly operation: 'codex' | 'images' | 'control';
  readonly rejectedToken?: string;
}

interface ActiveAccess {
  readonly kind: 'active';
  readonly token: Secret<string>;
  readonly deviceId: string;
  readonly renewable: boolean;
  readonly planType: string | null;
}

interface RefusedAccess {
  readonly kind: 'error';
  readonly source: 'local' | 'upstream';
  readonly status: number;
  readonly type: string;
  readonly error: Error;
  readonly retryAfter?: string;
  readonly transportError?: ErrorSnapshot;
  readonly terminal?: Promise<ChatGPTPersistence>;
}

type Access = ActiveAccess | RefusedAccess;

class ChatGPTAccessBlockedError extends Error {
  constructor(message: string, readonly status: number = 503, readonly type = 'chatgpt_upstream_unavailable', readonly retryAfter?: string) {
    super(message);
    this.name = 'ChatGPTAccessBlockedError';
  }
}

interface EnsureOptions {
  readonly force?: boolean;
  readonly rejectedToken?: string;
  readonly fallbackPlan?: ChatGPTPlanObservation;
  readonly guard?: (account: ChatGPTAccountCredential) => void;
  readonly signal?: AbortSignal;
}

const editAccount = async (
  upstreamId: string, accountId: AccountId,
  edit: (account: ChatGPTAccountCredential) => ChatGPTAccountCredential,
  missing: MissingAccountOptions['onMissing'] = 'throw',
): Promise<void> => {
  await getProviderRepo().upstreams.saveState(upstreamId, current => {
    const state = readChatGPTUpstreamState(current);
    const index = findChatGPTAccountIndex(state, accountId);
    if (index < 0) {
      if (missing === 'noop') return current;
      throw new TypeError(`ChatGPT upstream ${upstreamId} state has no credential for account ${accountId}`);
    }
    const account = state.accounts[index];
    const next = edit(account);
    return next === account ? current : replaceChatGPTAccount(state, index, () => next);
  });
};

const loadAccount = async (upstreamId: string, accountId: AccountId) => {
  const record = await getProviderRepo().upstreams.getById(upstreamId);
  if (!record) return null;
  const account = readChatGPTUpstreamState(record.state).accounts.find(value => value.chatgptAccountId === accountId);
  if (!account) throw new TypeError(`ChatGPT upstream ${upstreamId} state has no credential for account ${accountId}`);
  return { record, account };
};

const requireActive = (account: ChatGPTAccountCredential): void => {
  if (account.state !== 'active') throw new ChatGPTAccessBlockedError(`ChatGPT upstream is ${account.state}`);
};

const requireQuota = (account: ChatGPTAccountCredential, now: number): void => {
  const until = Math.max(...Object.values(account.quotaSnapshot ?? {}).map(({ data }) =>
    Date.parse(projectChatGPTQuota(data).ratelimited_until ?? '') || 0));
  if (until <= now) return;
  throw new ChatGPTAccessBlockedError('ChatGPT upstream is rate limited', 429, 'rate_limit_exceeded', String(Math.ceil((until - now) / 1000)));
};

const accessOnlyError = (account: ChatGPTAccountCredential, force: boolean): ChatGPTAccessOnlyCredentialError => {
  if (force) return new ChatGPTAccessOnlyCredentialError('ChatGPT access-only credentials cannot be refreshed; re-import the credential');
  if (account.accessToken?.expiresAt != null && account.accessToken.expiresAt <= Date.now()) {
    return new ChatGPTAccessOnlyCredentialError('ChatGPT access token has expired and cannot be refreshed; re-import the credential');
  }
  return new ChatGPTAccessOnlyCredentialError('ChatGPT access-only credential has no usable access token; re-import the credential');
};

const receipt = async (write: Promise<void>): Promise<ChatGPTPersistence> => {
  try {
    await write;
    return { persisted: true };
  } catch (error) {
    return { persisted: false, error: snapshotError(error) };
  }
};

const waitForRefresh = async (pending: Promise<RefreshResult>, signal?: AbortSignal): Promise<RefreshResult> => {
  if (signal === undefined) return await pending;
  const { promise, reject } = Promise.withResolvers<never>();
  const interrupt = (): void => reject(signal.reason);
  if (signal.aborted) interrupt();
  else signal.addEventListener('abort', interrupt, { once: true });
  try {
    return await Promise.race([pending, promise]);
  } finally {
    signal.removeEventListener('abort', interrupt);
  }
};

export interface ChatGPTService {
  access(request: AccessRequest): Promise<Access>;
  persistRejectedAccess(upstream: ChatGPTUpstreamFacts, access: ActiveAccess, message: string): Promise<ChatGPTPersistence>;
  observeQuota(upstream: ChatGPTUpstreamFacts, headers: Headers, status: number, images: boolean, now: Date): Promise<ChatGPTPersistence> | undefined;
  runScheduledTask(upstream: ChatGPTUpstreamFacts, options: ProviderScheduledOptions): Promise<void>;
  ensureAccessToken(upstreamId: string, accountId: AccountId, mint: Mint, force?: boolean): Promise<ChatGPTAccessTokenEntry>;
  putAccessToken(upstreamId: string, accountId: AccountId, entry: ChatGPTAccessTokenEntry, fallbackPlan?: ChatGPTPlanObservation): Promise<ChatGPTAccessTokenEntry>;
  invalidateAccessToken(upstreamId: string, accountId: AccountId, expectedToken?: string): Promise<ChatGPTAccessTokenEntry | null>;
  persistRefreshTokenRotation(upstreamId: string, accountId: AccountId, refreshToken: string, options?: MissingAccountOptions): Promise<void>;
  persistTerminalState(upstreamId: string, accountId: AccountId, state: TerminalState, message: string, options?: MissingAccountOptions): Promise<void>;
  getQuota(upstreamId: string, accountId: AccountId): Promise<ChatGPTQuotaSnapshotMap | null>;
  putQuota(upstreamId: string, accountId: AccountId, snapshot: ChatGPTQuotaSnapshot): Promise<void>;
  clearQuota(upstreamId: string, accountId: AccountId): Promise<void>;
}

export type ChatGPTServices = ProviderServices & { readonly chatgpt: ChatGPTService };

export const createChatGPTService = (): ChatGPTService => {
  const inFlight = new Map<string, Map<string, Promise<RefreshResult>>>();

  const putAccessToken: ChatGPTService['putAccessToken'] = async (upstreamId, accountId, entry, fallbackPlan) => {
    let effective = entry;
    await editAccount(upstreamId, accountId, account => {
      effective = mergeChatGPTAccessTokenEntry(entry, account.accessToken, fallbackPlan);
      return JSON.stringify(effective) === JSON.stringify(account.accessToken) ? account : { ...account, accessToken: effective };
    });
    return effective;
  };

  const requireAccount = async (upstreamId: string, accountId: AccountId): Promise<ChatGPTAccountCredential> => {
    const loaded = await loadAccount(upstreamId, accountId);
    if (!loaded) throw new ChatGPTAccessBlockedError(`ChatGPT upstream ${upstreamId} disappeared mid-request`);
    requireActive(loaded.account);
    return loaded.account;
  };

  const refresh = async (
    upstreamId: string, accountId: AccountId, account: ChatGPTAccountCredential, mint: RefreshMint, options: EnsureOptions, recover: boolean,
  ): Promise<RefreshResult> => {
    const used = account.refresh_token;
    if (used === null) throw accessOnlyError(account, options.force === true);
    let minted;
    try {
      minted = await mint(used);
    } catch (error) {
      if (!(error instanceof ChatGPTOAuthSessionTerminatedError)) throw error;
      // invalid_grant also covers a token another isolate rotated out.
      if (error.code === 'invalid_grant' && recover) {
        const fresh = await requireAccount(upstreamId, accountId);
        options.guard?.(fresh);
        if (fresh.refresh_token !== used) {
          if (fresh.accessToken && fresh.accessToken.token !== options.rejectedToken && isAccessTokenUsable(fresh.accessToken, fresh.refresh_token !== null)) {
            return { kind: 'token', entry: fresh.accessToken };
          }
          return await refresh(upstreamId, accountId, fresh, mint, options, false);
        }
      }
      return { kind: 'terminal', error, refreshToken: used };
    }
    const fallbackPlan = chatgptPlanObservation(account.accessToken) ?? options.fallbackPlan;
    const { entry, rotatedToken } = minted;
    if (rotatedToken === undefined) {
      return { kind: 'token', entry: await putAccessToken(upstreamId, accountId, entry, fallbackPlan) };
    }

    // Both tokens must become visible in the same commit, so a concurrent
    // 401 never sees the new refresh token paired with the rejected bearer.
    let committed: ChatGPTAccessTokenEntry | undefined;
    await editAccount(upstreamId, accountId, current => {
      committed = undefined;
      if (current.state !== 'active' || current.refresh_token !== used) return current;
      committed = mergeChatGPTAccessTokenEntry(entry, current.accessToken, fallbackPlan);
      return { ...current, refresh_token: rotatedToken, accessToken: committed, state_updated_at: entry.refreshedAt };
    });
    if (committed !== undefined) return { kind: 'token', entry: committed };
    const fresh = await requireAccount(upstreamId, accountId);
    options.guard?.(fresh);
    if (fresh.accessToken && fresh.accessToken.token !== options.rejectedToken && isAccessTokenUsable(fresh.accessToken, fresh.refresh_token !== null)) {
      return { kind: 'token', entry: fresh.accessToken };
    }
    if (!recover) throw new ChatGPTAccessBlockedError('ChatGPT credential changed during refresh');
    return await refresh(upstreamId, accountId, fresh, mint, options, false);
  };

  const ensure = async (upstreamId: string, accountId: AccountId, mint: RefreshMint, options: EnsureOptions): Promise<{
    readonly result: RefreshResult;
    readonly account: ChatGPTAccountCredential;
  }> => {
    const account = await requireAccount(upstreamId, accountId);
    if (options.signal?.aborted) throw options.signal.reason;
    options.guard?.(account);
    const cached = account.accessToken;
    if (!options.force && cached && cached.token !== options.rejectedToken && isAccessTokenUsable(cached, account.refresh_token !== null)) {
      return { result: { kind: 'token', entry: cached }, account };
    }
    // Per-caller admission precedes coalescing so an in-flight mint cannot
    // bypass a state change or a newly observed rate limit.
    const key = JSON.stringify([accountId, account.refresh_token]);
    let slots = inFlight.get(upstreamId);
    if (!slots) {
      slots = new Map();
      inFlight.set(upstreamId, slots);
    }
    let pending = slots.get(key);
    if (pending === undefined) {
      const active = slots;
      pending = refresh(upstreamId, accountId, account, mint, options, true).finally(() => {
        active.delete(key);
        if (active.size === 0) inFlight.delete(upstreamId);
      });
      slots.set(key, pending);
    }
    return { result: await waitForRefresh(pending, options.signal), account };
  };

  const persistRotation = async (
    upstreamId: string, accountId: AccountId, refreshToken: string, options?: MissingAccountOptions, expected?: string,
  ): Promise<void> => {
    const stamp = new Date().toISOString();
    await editAccount(upstreamId, accountId, account => {
      if (expected !== undefined && account.refresh_token !== expected) return account;
      return { ...account, refresh_token: refreshToken, state_updated_at: stamp };
    }, options?.onMissing ?? 'noop');
  };

  const persistTerminal = async (
    upstreamId: string, accountId: AccountId, state: TerminalState, message: string, options?: MissingAccountOptions,
    matches = (_account: ChatGPTAccountCredential) => true,
  ): Promise<void> => {
    const stamp = new Date().toISOString();
    await editAccount(upstreamId, accountId, account => {
      if (!matches(account)) return account;
      return { ...account, state, state_message: message, state_updated_at: stamp, accessToken: null };
    }, options?.onMissing ?? 'noop');
  };

  const access: ChatGPTService['access'] = async request => {
    const { upstream } = request;
    const { chatgptAccountId: accountId, planType: configuredPlan } = upstream.config.account;
    try {
      const { result, account } = await ensure(upstream.id, accountId, async used => {
        // The shared mint must commit a rotated refresh token even if one of
        // its waiters leaves while the issuer is processing the request.
        const tokens = await refreshChatGPTAccessToken(used, request.fetcher);
        try {
          return { entry: chatgptAccessTokenFromRefresh(tokens), rotatedToken: tokens.refresh_token };
        } catch (error) {
          if (!(error instanceof ChatGPTOAuthResponseError)) throw error;
          await persistRotation(upstream.id, accountId, tokens.refresh_token, { onMissing: 'throw' }, used);
          throw error;
        }
      }, {
        rejectedToken: request.rejectedToken,
        signal: request.signal,
        ...(request.operation === 'images' && configuredPlan !== null ? { fallbackPlan: { planType: configuredPlan } } : {}),
        guard: request.operation === 'control' ? undefined : account => requireQuota(account, request.now),
      });
      if (result.kind === 'terminal') {
        return {
          kind: 'error',
          source: 'upstream',
          status: 503,
          type: 'chatgpt_upstream_unavailable',
          error: result.error,
          terminal: receipt(persistTerminal(upstream.id, accountId, 'refresh_failed', result.error.upstreamMessage,
            { onMissing: 'throw' }, current => current.state === 'active' && current.refresh_token === result.refreshToken)),
        };
      }
      const planType = result.entry.planType ?? configuredPlan;
      if (request.operation === 'images' && !chatgptPlanSupportsImages(planType ?? undefined)) {
        throw new ChatGPTAccessBlockedError('ChatGPT Free accounts do not provide Codex image tools.', 403, 'image_tools_unavailable');
      }
      return { kind: 'active', token: secret(result.entry.token), deviceId: account.openaiDeviceId, renewable: account.refresh_token !== null, planType };
    } catch (error) {
      if (request.signal?.aborted) throw error;
      if (error instanceof ChatGPTAccessBlockedError) {
        return { kind: 'error', source: 'local', status: error.status, type: error.type, error, retryAfter: error.retryAfter };
      }
      if (error instanceof UpstreamGoneError || error instanceof ChatGPTAccessOnlyCredentialError) {
        return { kind: 'error', source: 'local', status: 503, type: 'chatgpt_upstream_unavailable', error };
      }
      if (error instanceof ChatGPTOAuthResponseError) {
        return { kind: 'error', source: 'upstream', status: 502, type: 'chatgpt_refresh_failed', error };
      }
      if (isUpstreamTransportError(error)) {
        return { kind: 'error', source: 'upstream', status: 502, type: 'upstream_transport_error', error, transportError: snapshotError(error) };
      }
      throw error;
    }
  };

  const putQuota: ChatGPTService['putQuota'] = async (upstreamId, accountId, snapshot) => {
    const fetchedAt = Date.parse(snapshot.observed_at);
    const key = chatgptQuotaActiveLimitKey(snapshot);
    await editAccount(upstreamId, accountId, account => {
      const current = account.quotaSnapshot?.[key];
      if (current !== undefined && current.fetchedAt > fetchedAt) return account;
      return { ...account, quotaSnapshot: { ...account.quotaSnapshot, [key]: { fetchedAt, data: snapshot } } };
    });
    await recordUpstreamMetrics(upstreamId, chatgptMetrics(snapshot), fetchedAt);
  };

  return {
    access,
    persistRejectedAccess: (upstream, rejected, message) => receipt(persistTerminal(
      upstream.id, upstream.config.account.chatgptAccountId, 'session_terminated', message,
      { onMissing: 'throw' }, account => account.accessToken?.token === rejected.token.reveal(),
    )),
    observeQuota: (upstream, headers, status, images, now) => {
      const isRateLimited = status === 429;
      if (!isRateLimited && (status < 200 || status >= 300)) return undefined;
      const snapshot = parseChatGPTQuotaHeaders(headers, { now, isRateLimited });
      if (images && !hasChatGPTQuotaReading(snapshot)) return undefined;
      return receipt(putQuota(upstream.id, upstream.config.account.chatgptAccountId, snapshot));
    },
    runScheduledTask: async (upstream, options) => {
      const loaded = await loadAccount(upstream.id, upstream.config.account.chatgptAccountId);
      if (loaded?.account.state !== 'active') return;
      const observations = Object.values(loaded.account.quotaSnapshot ?? {}).map(snapshot => snapshot.fetchedAt);
      await runScheduledUsageRefresh(loaded.record, options, observations.length === 0 ? null : Math.min(...observations), async (record, fetcher) => {
        const fresh = toChatGPTUpstreamFacts(record);
        const decision = await access({ upstream: fresh, fetcher, now: Date.now(), operation: 'control' });
        if (decision.kind === 'error') {
          const persisted = await decision.terminal;
          if (persisted?.persisted === false) console.warn('ChatGPT could not persist terminal state', persisted.error);
          throw decision.error;
        }
        const accountId = fresh.config.account.chatgptAccountId;
        const snapshots = await fetchChatGPTUsage(decision.token.reveal(), accountId, fetcher);
        for (const snapshot of snapshots) await putQuota(fresh.id, accountId, snapshot);
      });
    },
    ensureAccessToken: async (upstreamId, accountId, mint, force) => {
      const { result } = await ensure(upstreamId, accountId, async used => ({ entry: await mint(used) }), { force });
      if (result.kind === 'terminal') throw result.error;
      return result.entry;
    },
    putAccessToken,
    invalidateAccessToken: async (upstreamId, accountId, expectedToken) => {
      let retained: ChatGPTAccessTokenEntry | null = null;
      await editAccount(upstreamId, accountId, account => {
        const entry = account.accessToken;
        retained = entry !== null && expectedToken !== undefined && entry.token !== expectedToken ? entry : null;
        return retained !== null || entry === null ? account : { ...account, accessToken: null };
      });
      return retained;
    },
    persistRefreshTokenRotation: persistRotation,
    persistTerminalState: persistTerminal,
    getQuota: async (upstreamId, accountId) => {
      const loaded = await loadAccount(upstreamId, accountId);
      const snapshots = loaded?.account.quotaSnapshot;
      if (!snapshots || Object.keys(snapshots).length === 0) return null;
      return Object.fromEntries(Object.entries(snapshots).map(([key, entry]) => [key, projectChatGPTQuota(entry.data)]));
    },
    putQuota,
    // Re-fetch limits after a successful earned reset.
    // https://github.com/openai/codex/blob/ac7634b9f73ec1bf96466be7a5869f0949d20b30/codex-rs/app-server/README.md#8-earned-rate-limit-resets-chatgpt
    clearQuota: async (upstreamId, accountId) =>
      await editAccount(upstreamId, accountId, account => account.quotaSnapshot === null ? account : { ...account, quotaSnapshot: null }),
  };
};

export const chatgptService = createChatGPTService();
