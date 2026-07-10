// The dashboard-side Agent Setup state machine: one instance per mounted page,
// it acquires a setup lease, keeps the editable draft in sync with the server
// under optimistic concurrency, and renews the lease while the tab is visible.
//
// Concurrency model. A single serialized pump owns every mutating request, so a
// configuration PUT and a lease heartbeat never overlap. Saves are debounced and
// coalesced; the pump always drains a pending save before a due heartbeat. Local
// intent is tracked by a monotonic draft generation that is deliberately separate
// from the server's configuration revision: `formGeneration` bumps on each edit,
// `confirmedGeneration` follows the server's acknowledgements, and the two only
// meeting means the draft is fully persisted. A response for an older generation
// still adopts the freshest lease metadata (token, revision, expiry, script URLs)
// but never rewinds a newer draft.

import type { InferResponseType } from 'hono/client';
import { computed, onScopeDispose, ref, toValue, type MaybeRefOrGetter, type Ref } from 'vue';

import { callApi, type ApiClient } from '../api/client.ts';

// Debounce window before an edit is flushed as a PUT.
const SAVE_DEBOUNCE_MS = 400;
// Lease heartbeat cadence while the tab is visible.
const HEARTBEAT_INTERVAL_MS = 60_000;
// Backoff before retrying a save or heartbeat that failed on the transport.
const RETRY_DELAY_MS = 15_000;
// Per-request ceiling; a request still outstanding at this point is aborted and
// treated as a transport failure so the pump does not wedge on a dead socket.
const REQUEST_TIMEOUT_MS = 20_000;

// The `status: 'ok'` lease body every mutating route returns on success. Derived
// from the RPC client type so a backend field rename surfaces here at compile
// time rather than as a silent runtime mismatch.
type LeaseOkResponse = Extract<InferResponseType<ApiClient['api']['setup']['$put']>, { status: 'ok' }>;
export type AgentSetupConfiguration = LeaseOkResponse['configuration'];
type LeaseScripts = LeaseOkResponse['scripts'];

interface LeaseMetadata {
  token: string;
  configurationRevision: number;
  expiresAt: number;
  scripts: LeaseScripts;
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
  save: () => void;
  heartbeat: () => void;
  dispose: () => void;
}

const snapshot = (configuration: AgentSetupConfiguration): AgentSetupConfiguration =>
  JSON.parse(JSON.stringify(configuration)) as AgentSetupConfiguration;

// Extract the machine-readable `{ status }` a backend 409 carries. callApi routes
// the parsed 409 body through `GlobalError.raw`, so this reads that discriminant
// structurally — never by matching an English message.
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

// Race a request against the timeout, aborting the in-flight fetch when it wins so
// a dead socket is freed rather than left dangling.
const raceTimeout = <T>(request: (signal: AbortSignal) => Promise<T>): Promise<T> => {
  const controller = new AbortController();
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => {
      controller.abort();
      reject(new Error('Agent setup request timed out'));
    }, REQUEST_TIMEOUT_MS);
    request(controller.signal).then(
      value => { clearTimeout(timer); resolve(value); },
      (error: unknown) => { clearTimeout(timer); reject(error); },
    );
  });
};

export const useAgentSetup = (
  api: ApiClient,
  // Ids of the API keys the account can currently serve. When supplied, copy is
  // gated on the draft's selected key still being among them; omit to leave that
  // check to the caller.
  selectableKeyIds: MaybeRefOrGetter<readonly string[] | null> = null,
): UseAgentSetup => {
  const initialized = ref(false);
  const token = ref<string | null>(null);
  const configurationRevision = ref<number | null>(null);
  const expiresAt = ref<number | null>(null);
  const scripts = ref<LeaseScripts | null>(null);
  const noSelectableKey = ref(false);
  const error = ref<string | null>(null);
  const draft = ref<AgentSetupConfiguration | null>(null);

  // Monotonic local draft version and the highest version the server has
  // acknowledged. Dirty ⇔ they differ.
  const formGeneration = ref(0);
  const confirmedGeneration = ref(0);
  const superseded = ref(false);
  // Reactive clock the copy gate reads; refreshed on every lease interaction so
  // an expiry check re-evaluates without a standalone ticker.
  const nowMs = ref(Date.now());

  let debounceTimer: ReturnType<typeof setTimeout> | null = null;
  let heartbeatTimer: ReturnType<typeof setTimeout> | null = null;
  let saveRetryTimer: ReturnType<typeof setTimeout> | null = null;
  let savePending = false;
  let heartbeatDue = false;
  let pumpRunning = false;
  let disposed = false;

  const clearTimer = (timer: ReturnType<typeof setTimeout> | null): null => {
    if (timer !== null) clearTimeout(timer);
    return null;
  };

  const adoptLeaseMetadata = (lease: LeaseMetadata) => {
    token.value = lease.token;
    configurationRevision.value = lease.configurationRevision;
    expiresAt.value = lease.expiresAt;
    scripts.value = lease.scripts;
    nowMs.value = Date.now();
  };

  const markSuperseded = () => {
    superseded.value = true;
    debounceTimer = clearTimer(debounceTimer);
    heartbeatTimer = clearTimer(heartbeatTimer);
    saveRetryTimer = clearTimer(saveRetryTimer);
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

  const runSave = async () => {
    if (!initialized.value || token.value === null || configurationRevision.value === null || draft.value === null) return;
    const generation = formGeneration.value;
    const configuration = snapshot(draft.value);
    const currentToken = token.value;
    const expectedRevision = configurationRevision.value;

    const result = await callApi<LeaseOkResponse>(() => raceTimeout(signal =>
      api.api.setup.$put({ json: { token: currentToken, configuration, expectedRevision } }, { init: { signal } })));
    if (disposed) return;

    if (result.error) {
      const status = rawStatus(result.error.raw);
      if (status === 'superseded') { markSuperseded(); return; }
      if (status === 'revision-conflict') { reconcileRevisionConflict(result.error.raw, generation); return; }
      error.value = result.error.message;
      scheduleSaveRetry();
      return;
    }

    error.value = null;
    saveRetryTimer = clearTimer(saveRetryTimer);
    adoptLeaseMetadata(result.data);
    if (generation > confirmedGeneration.value) confirmedGeneration.value = generation;
  };

  const reconcileRevisionConflict = (raw: unknown, savedGeneration: number) => {
    const lease = asLease(raw);
    if (lease === null) { error.value = 'Received an unexpected conflict response from the server.'; return; }
    adoptLeaseMetadata(lease);
    if (formGeneration.value > savedGeneration) {
      // A newer local edit outranks the server's copy — resubmit against the
      // revision we just learned. The pump loop picks this up on its next turn.
      savePending = true;
      return;
    }
    // No newer intent: take the server's configuration and settle clean.
    const body = raw as LeaseOkResponse;
    draft.value = snapshot(body.configuration);
    confirmedGeneration.value = formGeneration.value;
  };

  const runHeartbeat = async () => {
    if (!initialized.value || token.value === null) return;
    const currentToken = token.value;
    // Refresh the copy gate's clock on every attempt, so a lease that lapses
    // while heartbeats keep failing still flips `canCopy` false.
    nowMs.value = Date.now();

    const result = await callApi<LeaseOkResponse>(() => raceTimeout(signal =>
      api.api.setup.heartbeat.$post({ json: { token: currentToken } }, { init: { signal } })));
    if (disposed) return;

    if (result.error) {
      if (rawStatus(result.error.raw) === 'superseded') { markSuperseded(); return; }
      scheduleHeartbeat(RETRY_DELAY_MS);
      return;
    }
    adoptLeaseMetadata(result.data);
    scheduleHeartbeat(HEARTBEAT_INTERVAL_MS);
  };

  // The serialized pump: drains a pending save before a due heartbeat, one at a
  // time, so a heartbeat can never overlap an in-flight PUT.
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
    debounceTimer = clearTimer(debounceTimer);
    saveRetryTimer = clearTimer(saveRetryTimer);
    debounceTimer = setTimeout(() => {
      debounceTimer = null;
      savePending = true;
      kickPump();
    }, SAVE_DEBOUNCE_MS);
  };

  const save = () => {
    if (disposed || superseded.value || !initialized.value) return;
    formGeneration.value += 1;
    scheduleDebouncedSave();
  };

  const heartbeat = () => {
    if (disposed || superseded.value || !initialized.value) return;
    heartbeatDue = true;
    kickPump();
  };

  const create = async () => {
    const result = await callApi<LeaseOkResponse>(() => raceTimeout(signal =>
      api.api.setup.$post({ json: { publicBaseUrl: window.location.origin } }, { init: { signal } })));
    if (disposed) return;

    if (result.error) {
      if (rawStatus(result.error.raw) === 'no-selectable-key') { noSelectableKey.value = true; return; }
      error.value = result.error.message;
      return;
    }

    adoptLeaseMetadata(result.data);
    draft.value = snapshot(result.data.configuration);
    formGeneration.value = 0;
    confirmedGeneration.value = 0;
    initialized.value = true;
    scheduleHeartbeat(HEARTBEAT_INTERVAL_MS);
  };

  const onVisibilityChange = () => {
    if (disposed || superseded.value) return;
    if (document.visibilityState === 'hidden') {
      // Pause scheduling; in-flight work finishes on its own.
      heartbeatTimer = clearTimer(heartbeatTimer);
      return;
    }
    nowMs.value = Date.now();
    if (!initialized.value) return;
    // Resume: reconcile the lease immediately and flush any dirty draft.
    heartbeatDue = true;
    if (formGeneration.value !== confirmedGeneration.value) savePending = true;
    kickPump();
  };

  const dispose = () => {
    if (disposed) return;
    disposed = true;
    debounceTimer = clearTimer(debounceTimer);
    heartbeatTimer = clearTimer(heartbeatTimer);
    saveRetryTimer = clearTimer(saveRetryTimer);
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
