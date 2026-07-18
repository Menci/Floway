// The dashboard-side Agent Setup state machine: one instance per mounted page,
// it acquires a setup lease, keeps the editable draft in sync with the server
// under optimistic concurrency, and renews the lease while the tab is visible.
//
// Every page owns an independent lease keyed by its own token; pages never
// supersede one another. One serialized pump owns every PUT and heartbeat, so
// this page's mutations never overlap. Local form generations are independent
// of server configuration revisions: an old response may advance lease
// metadata, but cannot overwrite a newer draft. A lease becomes terminal only
// when the server no longer recognizes this page's token (it expired and was
// swept) — reported as `terminated`.

import type { InferResponseType } from 'hono/client';
import { computed, onScopeDispose, ref, toValue, watch, type MaybeRefOrGetter, type Ref } from 'vue';

import { callApi, type ApiClient } from '../api/client.ts';

const SAVE_DEBOUNCE_MS = 400;
const HEARTBEAT_INTERVAL_MS = 60_000;
const RETRY_DELAY_MS = 15_000;
const REQUEST_TIMEOUT_MS = 20_000;

type LeaseOkResponse = Extract<InferResponseType<ApiClient['api']['setup']['$put']>, { status: 'ok' }>;
export type AgentSetupConfiguration = LeaseOkResponse['configuration'];
type LeaseScripts = LeaseOkResponse['scripts'];

interface LeaseMetadata {
  token: string;
  configurationRevision: number;
  expiresAt: number;
  configuration: AgentSetupConfiguration;
  scripts: LeaseScripts;
}

interface ActiveRequest {
  controller: AbortController;
  timeout: ReturnType<typeof setTimeout> | null;
}

export interface AgentSetupState {
  initialized: Ref<boolean>;
  scripts: Ref<LeaseScripts | null>;
  noSelectableKey: Ref<boolean>;
  error: Ref<string | null>;
}

export interface UseAgentSetup {
  state: AgentSetupState;
  draft: Ref<AgentSetupConfiguration | null>;
  syncing: Ref<boolean>;
  terminated: Ref<boolean>;
  canCopy: Ref<boolean>;
  retryCreate: () => void;
}

const snapshot = (configuration: AgentSetupConfiguration): AgentSetupConfiguration =>
  JSON.parse(JSON.stringify(configuration)) as AgentSetupConfiguration;

// Structural equality for two configurations, independent of key order (the
// server re-serializes through its schema, so its key order need not match the
// draft's). Used to decide whether a revision conflict already holds exactly
// what we attempted.
const configurationsEqual = (a: unknown, b: unknown): boolean => {
  if (a === b) return true;
  if (typeof a !== 'object' || typeof b !== 'object' || a === null || b === null) return false;
  const aKeys = Object.keys(a as Record<string, unknown>);
  const bKeys = Object.keys(b as Record<string, unknown>);
  if (aKeys.length !== bKeys.length) return false;
  return aKeys.every(key => configurationsEqual((a as Record<string, unknown>)[key], (b as Record<string, unknown>)[key]));
};

const rawStatus = (raw: unknown): string | null =>
  raw !== null && typeof raw === 'object' && typeof (raw as { status?: unknown }).status === 'string'
    ? (raw as { status: string }).status
    : null;

const asLease = (raw: unknown): LeaseMetadata | null => {
  if (raw === null || typeof raw !== 'object') return null;
  const body = raw as Partial<LeaseOkResponse>;
  if (typeof body.token !== 'string' || typeof body.configurationRevision !== 'number'
    || typeof body.expiresAt !== 'number' || body.configuration === undefined
    || body.scripts === undefined) return null;
  return {
    token: body.token,
    configurationRevision: body.configurationRevision,
    expiresAt: body.expiresAt,
    configuration: body.configuration,
    scripts: body.scripts,
  };
};

const isRetryableHttpStatus = (status: number): boolean =>
  status === 0 || status === 408 || status === 429 || status >= 500;

export const useAgentSetup = (
  api: ApiClient,
  selectableKeyIds: MaybeRefOrGetter<readonly string[] | null> = null,
  active: MaybeRefOrGetter<boolean> = true,
): UseAgentSetup => {
  const initialized = ref(false);
  const token = ref<string | null>(null);
  const configurationRevision = ref<number | null>(null);
  const expiresAt = ref<number | null>(null);
  const scripts = ref<LeaseScripts | null>(null);
  const noSelectableKey = ref(false);
  // Each operation owns its error. A successful heartbeat must not erase a
  // rejected form save; only that save stream can clear its own failure.
  const createError = ref<string | null>(null);
  const saveError = ref<string | null>(null);
  const heartbeatError = ref<string | null>(null);
  const error = computed(() => saveError.value ?? heartbeatError.value ?? createError.value);
  const draft = ref<AgentSetupConfiguration | null>(null);
  const formGeneration = ref(0);
  const confirmedGeneration = ref(0);
  const terminated = ref(false);
  const nowMs = ref(Date.now());

  let debounceTimer: ReturnType<typeof setTimeout> | null = null;
  let heartbeatTimer: ReturnType<typeof setTimeout> | null = null;
  let saveRetryTimer: ReturnType<typeof setTimeout> | null = null;
  let expiryTimer: ReturnType<typeof setTimeout> | null = null;
  let activeRequest: ActiveRequest | null = null;
  let savePending = false;
  let heartbeatDue = false;
  let pumpRunning = false;
  let disposed = false;
  let installingDraft = false;
  let createAttempt = 0;

  const clearTimer = (timer: ReturnType<typeof setTimeout> | null): null => {
    if (timer !== null) clearTimeout(timer);
    return null;
  };

  const scheduleExpiry = (expiry: number) => {
    expiryTimer = clearTimer(expiryTimer);
    const delay = Math.max(0, expiry - Date.now());
    expiryTimer = setTimeout(() => {
      expiryTimer = null;
      nowMs.value = Date.now();
    }, delay);
  };

  const adoptLeaseMetadata = (lease: LeaseMetadata) => {
    token.value = lease.token;
    configurationRevision.value = lease.configurationRevision;
    expiresAt.value = lease.expiresAt;
    scripts.value = lease.scripts;
    nowMs.value = Date.now();
    scheduleExpiry(lease.expiresAt);
  };

  const installDraft = (configuration: AgentSetupConfiguration) => {
    installingDraft = true;
    draft.value = snapshot(configuration);
    installingDraft = false;
  };

  const abortActiveRequest = () => {
    const request = activeRequest;
    if (request === null) return;
    activeRequest = null;
    request.timeout = clearTimer(request.timeout);
    request.controller.abort();
  };

  // The active AbortController and timeout are instance-owned so dispose can
  // synchronously release both even when the underlying fetch never settles.
  const requestWithTimeout = <T>(request: (signal: AbortSignal) => Promise<T>): Promise<T> => {
    if (activeRequest !== null) throw new Error('Agent setup mutation requests must be serialized');
    const state: ActiveRequest = { controller: new AbortController(), timeout: null };
    activeRequest = state;

    return new Promise<T>((resolve, reject) => {
      let settled = false;
      const finish = (complete: () => void) => {
        if (settled) return;
        settled = true;
        state.timeout = clearTimer(state.timeout);
        if (activeRequest === state) activeRequest = null;
        complete();
      };

      state.timeout = setTimeout(() => {
        state.controller.abort();
        finish(() => reject(new Error('Agent setup request timed out')));
      }, REQUEST_TIMEOUT_MS);

      try {
        request(state.controller.signal).then(
          value => finish(() => resolve(value)),
          (reason: unknown) => finish(() => reject(reason)),
        );
      } catch (reason: unknown) {
        finish(() => reject(reason));
      }
    });
  };

  const markTerminated = () => {
    terminated.value = true;
    debounceTimer = clearTimer(debounceTimer);
    heartbeatTimer = clearTimer(heartbeatTimer);
    saveRetryTimer = clearTimer(saveRetryTimer);
    expiryTimer = clearTimer(expiryTimer);
    savePending = false;
    heartbeatDue = false;
  };

  const scheduleHeartbeat = (delay: number) => {
    heartbeatTimer = clearTimer(heartbeatTimer);
    if (disposed || terminated.value || !toValue(active) || document.visibilityState === 'hidden') return;
    heartbeatTimer = setTimeout(() => {
      heartbeatTimer = null;
      heartbeatDue = true;
      kickPump();
    }, delay);
  };

  const scheduleSaveRetry = () => {
    saveRetryTimer = clearTimer(saveRetryTimer);
    if (disposed || terminated.value) return;
    saveRetryTimer = setTimeout(() => {
      saveRetryTimer = null;
      savePending = true;
      kickPump();
    }, RETRY_DELAY_MS);
  };

  const cancelScheduledSave = () => {
    debounceTimer = clearTimer(debounceTimer);
    saveRetryTimer = clearTimer(saveRetryTimer);
  };

  const queueImmediateSave = () => {
    cancelScheduledSave();
    savePending = true;
    kickPump();
  };

  // Each page is the only writer of its token, so a revision conflict can only
  // be a lost acknowledgement of one of our own writes. Freshest local intent wins.
  const reconcileRevisionConflict = (raw: unknown, attemptedConfiguration: AgentSetupConfiguration, savedGeneration: number) => {
    const lease = asLease(raw);
    if (lease === null) {
      saveError.value = 'Received an unexpected conflict response from the server.';
      return;
    }
    saveError.value = null;
    adoptLeaseMetadata(lease);

    if (formGeneration.value === savedGeneration && configurationsEqual(lease.configuration, attemptedConfiguration)) {
      installDraft(lease.configuration);
      confirmedGeneration.value = formGeneration.value;
      return;
    }
    // Cancel any debounce the newer edit scheduled before resubmitting, so a
    // stale timer cannot emit a duplicate PUT after the resubmit succeeds.
    queueImmediateSave();
  };

  const runSave = async () => {
    if (!initialized.value || token.value === null || configurationRevision.value === null || draft.value === null) return;
    const generation = formGeneration.value;
    const configuration = snapshot(draft.value);
    const currentToken = token.value;
    const expectedRevision = configurationRevision.value;
    const result = await callApi<LeaseOkResponse>(() => requestWithTimeout(signal =>
      api.api.setup.$put({ json: { token: currentToken, configuration, expectedRevision } }, { init: { signal } })));
    if (disposed) return;

    if (result.error) {
      const status = rawStatus(result.error.raw);
      if (status === 'missing') { markTerminated(); return; }
      if (status === 'revision-conflict') { reconcileRevisionConflict(result.error.raw, configuration, generation); return; }
      saveError.value = result.error.message;
      if (isRetryableHttpStatus(result.error.status)) scheduleSaveRetry();
      return;
    }

    saveError.value = null;
    saveRetryTimer = clearTimer(saveRetryTimer);
    adoptLeaseMetadata(result.data);
    if (generation > confirmedGeneration.value) confirmedGeneration.value = generation;
  };

  const runHeartbeat = async () => {
    if (!initialized.value || token.value === null || !toValue(active)) return;
    const currentToken = token.value;
    nowMs.value = Date.now();

    const result = await callApi<LeaseOkResponse>(() => requestWithTimeout(signal =>
      api.api.setup.heartbeat.$post({ json: { token: currentToken } }, { init: { signal } })));
    if (disposed) return;

    if (result.error) {
      const status = rawStatus(result.error.raw);
      if (status === 'missing') { markTerminated(); return; }
      heartbeatError.value = result.error.message;
      if (isRetryableHttpStatus(result.error.status)) scheduleHeartbeat(RETRY_DELAY_MS);
      return;
    }
    heartbeatError.value = null;
    adoptLeaseMetadata(result.data);
    scheduleHeartbeat(HEARTBEAT_INTERVAL_MS);
  };

  const kickPump = () => {
    if (pumpRunning || disposed || terminated.value) return;
    pumpRunning = true;
    void (async () => {
      try {
        while (!disposed && !terminated.value && (savePending || heartbeatDue)) {
          if (savePending) {
            savePending = false;
            await runSave();
          } else {
            heartbeatDue = false;
            await runHeartbeat();
          }
        }
      } finally {
        pumpRunning = false;
      }
    })();
  };

  const scheduleDebouncedSave = () => {
    cancelScheduledSave();
    debounceTimer = setTimeout(() => {
      debounceTimer = null;
      savePending = true;
      kickPump();
    }, SAVE_DEBOUNCE_MS);
  };

  const create = async () => {
    const attempt = ++createAttempt;
    const ids = toValue(selectableKeyIds);
    if (ids === null || ids.length === 0) throw new Error('Agent setup requires a selected API key');
    const result = await callApi<LeaseOkResponse>(() => requestWithTimeout(signal =>
      api.api.setup.$post({ json: { apiKeyId: ids[0]! } }, { init: { signal } })));
    // A retry (or dispose) that replaced this attempt owns the state now; drop
    // this stale attempt's outcome so an aborted create cannot resurrect an error.
    if (disposed || attempt !== createAttempt || !toValue(active)) return;

    if (result.error) {
      if (rawStatus(result.error.raw) === 'no-selectable-key') { noSelectableKey.value = true; return; }
      createError.value = result.error.message;
      return;
    }

    createError.value = null;
    adoptLeaseMetadata(result.data);
    installDraft(result.data.configuration);
    formGeneration.value = 0;
    confirmedGeneration.value = 0;
    initialized.value = true;
    scheduleHeartbeat(HEARTBEAT_INTERVAL_MS);
  };

  // Explicit recovery from a failed initial acquisition: abort any lingering
  // request, clear the surfaced error, and post exactly one more create. Guarded
  // to the pre-initialized window so a live lease is never re-created underneath.
  const retryCreate = () => {
    if (disposed || initialized.value || !toValue(active)) return;
    abortActiveRequest();
    createError.value = null;
    noSelectableKey.value = false;
    void create();
  };

  watch(draft, () => {
    if (disposed || terminated.value || !initialized.value || installingDraft) return;
    formGeneration.value += 1;
    scheduleDebouncedSave();
  }, { deep: true, flush: 'sync' });

  const onVisibilityChange = () => {
    if (disposed || terminated.value || !toValue(active)) return;
    if (document.visibilityState === 'hidden') {
      heartbeatTimer = clearTimer(heartbeatTimer);
      return;
    }
    nowMs.value = Date.now();
    if (!initialized.value) return;
    heartbeatDue = true;
    if (formGeneration.value !== confirmedGeneration.value) {
      // Visibility resume reconciles immediately. Remove a debounce left by an
      // edit made while hidden so it cannot issue a second PUT later.
      cancelScheduledSave();
      savePending = true;
    }
    kickPump();
  };

  const dispose = () => {
    if (disposed) return;
    disposed = true;
    debounceTimer = clearTimer(debounceTimer);
    heartbeatTimer = clearTimer(heartbeatTimer);
    saveRetryTimer = clearTimer(saveRetryTimer);
    expiryTimer = clearTimer(expiryTimer);
    abortActiveRequest();
    document.removeEventListener('visibilitychange', onVisibilityChange);
  };

  const syncing = computed(() => initialized.value && formGeneration.value !== confirmedGeneration.value);

  const canCopy = computed(() => {
    if (!toValue(active) || !initialized.value || terminated.value) return false;
    if (formGeneration.value !== confirmedGeneration.value) return false;
    if (expiresAt.value === null || expiresAt.value <= nowMs.value) return false;
    const ids = toValue(selectableKeyIds);
    if (ids !== null && (draft.value === null || !ids.includes(draft.value.apiKeyId))) return false;
    return true;
  });

  document.addEventListener('visibilitychange', onVisibilityChange);
  onScopeDispose(dispose);
  watch(() => toValue(active), enabled => {
    if (disposed) return;
    if (!enabled) {
      heartbeatTimer = clearTimer(heartbeatTimer);
      heartbeatDue = false;
      if (!initialized.value) {
        createAttempt += 1;
        abortActiveRequest();
      }
      return;
    }
    if (initialized.value) {
      nowMs.value = Date.now();
      heartbeatDue = true;
      kickPump();
      return;
    }
    if (activeRequest === null) void create();
  }, { immediate: true });

  return {
    state: { initialized, scripts, noSelectableKey, error },
    draft,
    syncing,
    terminated,
    canCopy,
    retryCreate,
  };
};
