// The dashboard-side Agent Setup state machine: one instance per mounted page,
// it acquires a setup lease, keeps the editable draft in sync with the server
// under optimistic concurrency, and renews the lease while the tab is visible.
//
// One serialized pump owns every PUT and heartbeat, so mutations never overlap.
// Local form generations are independent of server configuration revisions: an
// old response may advance lease metadata, but cannot overwrite a newer draft.

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
  scripts: LeaseScripts;
}

interface ActiveRequest {
  controller: AbortController;
  timeout: ReturnType<typeof setTimeout> | null;
}

export interface AgentSetupState {
  initialized: Ref<boolean>;
  token: Ref<string | null>;
  configurationRevision: Ref<number | null>;
  expiresAt: Ref<number | null>;
  scripts: Ref<LeaseScripts | null>;
  noSelectableKey: Ref<boolean>;
  error: Ref<string | null>;
}

export interface UseAgentSetup {
  state: AgentSetupState;
  draft: Ref<AgentSetupConfiguration | null>;
  syncing: Ref<boolean>;
  superseded: Ref<boolean>;
  canCopy: Ref<boolean>;
  // Deep draft mutations auto-save. `save` remains an ergonomic explicit flush
  // hook for forms that already call it after applying a batch of changes.
  save: () => void;
  heartbeat: () => void;
  dispose: () => void;
}

const snapshot = (configuration: AgentSetupConfiguration): AgentSetupConfiguration =>
  JSON.parse(JSON.stringify(configuration)) as AgentSetupConfiguration;

const rawStatus = (raw: unknown): string | null =>
  raw !== null && typeof raw === 'object' && typeof (raw as { status?: unknown }).status === 'string'
    ? (raw as { status: string }).status
    : null;

const asLease = (raw: unknown): LeaseMetadata | null => {
  if (raw === null || typeof raw !== 'object') return null;
  const body = raw as Partial<LeaseOkResponse>;
  if (typeof body.token !== 'string' || typeof body.configurationRevision !== 'number'
    || typeof body.expiresAt !== 'number' || body.scripts === undefined) return null;
  return { token: body.token, configurationRevision: body.configurationRevision, expiresAt: body.expiresAt, scripts: body.scripts };
};

const isRetryableHttpStatus = (status: number): boolean =>
  status === 0 || status === 408 || status === 429 || status >= 500;

export const useAgentSetup = (
  api: ApiClient,
  selectableKeyIds: MaybeRefOrGetter<readonly string[] | null> = null,
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
  const superseded = ref(false);
  const nowMs = ref(Date.now());

  let debounceTimer: ReturnType<typeof setTimeout> | null = null;
  let heartbeatTimer: ReturnType<typeof setTimeout> | null = null;
  let saveRetryTimer: ReturnType<typeof setTimeout> | null = null;
  let expiryTimer: ReturnType<typeof setTimeout> | null = null;
  let activeRequest: ActiveRequest | null = null;
  let savePending = false;
  let activeSaveGeneration: number | null = null;
  let heartbeatDue = false;
  let pumpRunning = false;
  let disposed = false;
  let installingDraft = false;

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

  const markSuperseded = () => {
    superseded.value = true;
    debounceTimer = clearTimer(debounceTimer);
    heartbeatTimer = clearTimer(heartbeatTimer);
    saveRetryTimer = clearTimer(saveRetryTimer);
    expiryTimer = clearTimer(expiryTimer);
    savePending = false;
    heartbeatDue = false;
  };

  const scheduleHeartbeat = (delay: number) => {
    heartbeatTimer = clearTimer(heartbeatTimer);
    if (disposed || superseded.value || document.visibilityState === 'hidden') return;
    heartbeatTimer = setTimeout(() => {
      heartbeatTimer = null;
      heartbeatDue = true;
      kickPump();
    }, delay);
  };

  const scheduleSaveRetry = () => {
    saveRetryTimer = clearTimer(saveRetryTimer);
    if (disposed || superseded.value) return;
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

  const reconcileRevisionConflict = (raw: unknown, savedGeneration: number) => {
    const lease = asLease(raw);
    if (lease === null) {
      saveError.value = 'Received an unexpected conflict response from the server.';
      return;
    }
    saveError.value = null;
    adoptLeaseMetadata(lease);
    if (formGeneration.value > savedGeneration) {
      // Cancel the newer edit's debounce before immediate resubmission; otherwise
      // its stale timer would emit a duplicate PUT after the resubmit succeeds.
      queueImmediateSave();
      return;
    }
    installDraft((raw as LeaseOkResponse).configuration);
    confirmedGeneration.value = formGeneration.value;
  };

  const runSave = async () => {
    if (!initialized.value || token.value === null || configurationRevision.value === null || draft.value === null) return;
    const generation = formGeneration.value;
    const configuration = snapshot(draft.value);
    const currentToken = token.value;
    const expectedRevision = configurationRevision.value;
    activeSaveGeneration = generation;

    const result = await callApi<LeaseOkResponse>(() => requestWithTimeout(signal =>
      api.api.setup.$put({ json: { token: currentToken, configuration, expectedRevision } }, { init: { signal } })));
    activeSaveGeneration = null;
    if (disposed) return;

    if (result.error) {
      const status = rawStatus(result.error.raw);
      if (status === 'superseded') { markSuperseded(); return; }
      if (status === 'revision-conflict') { reconcileRevisionConflict(result.error.raw, generation); return; }
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
    if (!initialized.value || token.value === null) return;
    const currentToken = token.value;
    nowMs.value = Date.now();

    const result = await callApi<LeaseOkResponse>(() => requestWithTimeout(signal =>
      api.api.setup.heartbeat.$post({ json: { token: currentToken } }, { init: { signal } })));
    if (disposed) return;

    if (result.error) {
      const status = rawStatus(result.error.raw);
      if (status === 'superseded') { markSuperseded(); return; }
      if (status === 'revision-conflict') {
        const lease = asLease(result.error.raw);
        if (lease !== null) {
          adoptLeaseMetadata(lease);
          heartbeatError.value = null;
          scheduleHeartbeat(HEARTBEAT_INTERVAL_MS);
          return;
        }
      }
      heartbeatError.value = result.error.message;
      if (isRetryableHttpStatus(result.error.status)) scheduleHeartbeat(RETRY_DELAY_MS);
      return;
    }
    heartbeatError.value = null;
    adoptLeaseMetadata(result.data);
    scheduleHeartbeat(HEARTBEAT_INTERVAL_MS);
  };

  const kickPump = () => {
    if (pumpRunning || disposed || superseded.value) return;
    pumpRunning = true;
    void (async () => {
      try {
        while (!disposed && !superseded.value && (savePending || heartbeatDue)) {
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

  const save = () => {
    if (disposed || superseded.value || !initialized.value) return;
    if (formGeneration.value === confirmedGeneration.value) return;
    // The deep watcher already queued this generation. Calling save() while its
    // PUT is active is an idempotent flush, not a request for a second PUT.
    if (formGeneration.value === activeSaveGeneration) return;
    scheduleDebouncedSave();
  };

  const heartbeat = () => {
    if (disposed || superseded.value || !initialized.value) return;
    // An explicit reconciliation replaces the scheduled cadence tick. Keeping
    // both would make a permanent 4xx appear to retry when the old timer fires.
    heartbeatTimer = clearTimer(heartbeatTimer);
    heartbeatDue = true;
    kickPump();
  };

  const create = async () => {
    const result = await callApi<LeaseOkResponse>(() => requestWithTimeout(signal =>
      api.api.setup.$post({ json: { publicBaseUrl: window.location.origin } }, { init: { signal } })));
    if (disposed) return;

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

  watch(draft, () => {
    if (disposed || superseded.value || !initialized.value || installingDraft) return;
    formGeneration.value += 1;
    scheduleDebouncedSave();
  }, { deep: true, flush: 'sync' });

  const onVisibilityChange = () => {
    if (disposed || superseded.value) return;
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
    if (!initialized.value || superseded.value) return false;
    if (formGeneration.value !== confirmedGeneration.value) return false;
    if (expiresAt.value === null || expiresAt.value <= nowMs.value) return false;
    const ids = toValue(selectableKeyIds);
    if (ids !== null && (draft.value === null || !ids.includes(draft.value.apiKeyId))) return false;
    return true;
  });

  document.addEventListener('visibilitychange', onVisibilityChange);
  onScopeDispose(dispose);
  void create();

  return {
    state: { initialized, token, configurationRevision, expiresAt, scripts, noSelectableKey, error },
    draft,
    syncing,
    superseded,
    canCopy,
    save,
    heartbeat,
    dispose,
  };
};
