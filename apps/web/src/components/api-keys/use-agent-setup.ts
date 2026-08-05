import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useStore } from 'zustand';
import { createStore } from 'zustand/vanilla';

import {
  applyLocalAgentSetupChanges,
  blankAgentSetupDraft,
  cloneAgentSetupConfiguration,
  type AgentSetupConfiguration,
  type AgentSetupLease,
} from './agent-setup';
import { api, callApi, type ApiCallResult } from '../../api/client';
import { useTranslation } from '../../i18n/translation';
import { isAbortError } from '../../lib/error-message';

interface ActiveRequest {
  controller: AbortController;
  timeout: ReturnType<typeof setTimeout>;
}

const SAVE_DEBOUNCE_MS = 400;
const HEARTBEAT_INTERVAL_MS = 60_000;
const RETRY_DELAY_MS = 15_000;
const REQUEST_TIMEOUT_MS = 20_000;

const clearTimer = (timer: { current: ReturnType<typeof setTimeout> | null }) => {
  if (timer.current !== null) clearTimeout(timer.current);
  timer.current = null;
};

const isRetryableStatus = (status: number) =>
  status === 0 || status === 408 || status === 429 || status >= 500;
// A configuration is a closed object of JSON scalars whose key order the
// gateway's schema fixes on both sides of the wire, so it compares by
// serializing, the way every other draft in this dashboard does.
const comparableConfiguration = (configuration: AgentSetupConfiguration): string => JSON.stringify(configuration);

export const agentSetupCommand = (origin: string, path: string, platform: 'unix' | 'windows'): string => platform === 'unix'
  ? `export SETUP_ENDPOINT='${origin.replaceAll("'", "'\\''")}'; curl -fsSL "$SETUP_ENDPOINT${path}" | bash`
  : `$SetupEndpoint = '${origin.replaceAll("'", "''")}'; irm "$SetupEndpoint${path}" | iex`;

// The lease is external state: a server owns it, timers renew and expire it,
// and the save and heartbeat callbacks have to act on what it holds when they
// run rather than on the render that created them. Holding the whole session in
// one store read through useSyncExternalStore gives every fact a single writer
// and puts render and callbacks on the same snapshot.
interface SetupSessionState {
  lease: AgentSetupLease | null;
  // The form is editable before a lease exists, so the draft outlives one.
  // baseline is the last configuration a server answered for -- what a lease
  // seeded, or what a save stored -- and the difference between the two is the
  // unsaved edit set the next lease must keep.
  draft: AgentSetupConfiguration;
  baseline: AgentSetupConfiguration;
  generation: number;
  confirmedGeneration: number;
  terminated: boolean;
  expired: boolean;
  noSelectableKey: boolean;
  createError: string | null;
  saveError: string | null;
  heartbeatError: string | null;
}

export interface AgentSetupSession {
  lease: AgentSetupLease | null;
  draft: AgentSetupConfiguration;
  error: string | null;
  createError: string | null;
  dismissError: () => void;
  terminated: boolean;
  noSelectableKey: boolean;
  syncing: boolean;
  canCopy: boolean;
  updateDraft: (update: (current: AgentSetupConfiguration) => AgentSetupConfiguration) => void;
  retryCreate: () => void;
}

export const useAgentSetup = (
  apiKeyId: string | null,
  initialLease: AgentSetupLease | null = null,
  initialCreateError: string | null = null,
  initialApiKeyId: string | null = null,
): AgentSetupSession => {
  const { t } = useTranslation();
  const initialResource = initialApiKeyId === apiKeyId
    ? { apiKeyId: initialApiKeyId, error: initialCreateError, lease: initialLease }
    : null;
  const initialResourceRef = useRef(initialResource);
  const [store] = useState(() => {
    const draft = initialResource?.lease
      ? cloneAgentSetupConfiguration(initialResource.lease.configuration)
      : blankAgentSetupDraft();
    return createStore<SetupSessionState>(() => ({
      lease: initialResource?.lease ?? null,
      draft,
      baseline: draft,
      generation: 0,
      confirmedGeneration: 0,
      terminated: false,
      expired: false,
      noSelectableKey: false,
      createError: initialResource?.error ?? null,
      saveError: null,
      heartbeatError: null,
    }));
  });
  const session = useStore(store);
  const [createAttempt, setCreateAttempt] = useState(0);

  const lifecycleRef = useRef(0);
  const queueRef = useRef(Promise.resolve());
  const activeRequestsRef = useRef(new Set<ActiveRequest>());
  const debounceTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const saveRetryTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const heartbeatTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const expiryTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const runSaveRef = useRef<() => Promise<void>>(async () => {});
  const heartbeatRef = useRef<() => Promise<void>>(async () => {});

  const abortRequests = useCallback(() => {
    for (const request of activeRequestsRef.current) {
      clearTimeout(request.timeout);
      request.controller.abort();
    }
    activeRequestsRef.current.clear();
  }, []);

  const request = useCallback(async <TResponse extends Response>(
    send: (signal: AbortSignal) => Promise<TResponse>,
  ): Promise<ApiCallResult<TResponse>> => {
    const controller = new AbortController();
    let timedOut = false;
    const requestState: ActiveRequest = {
      controller,
      timeout: setTimeout(() => { timedOut = true; controller.abort(); }, REQUEST_TIMEOUT_MS),
    };
    activeRequestsRef.current.add(requestState);
    try {
      const result = await callApi(() => send(controller.signal));
      // Our own deadline is a request timeout, and it is described in our own
      // words; the abort we raised to enforce it says nothing an operator can use.
      if (result.error && timedOut && isAbortError(result.error.cause)) {
        return { error: { status: 408, message: t('dashboard.apiKeys.agentSetup.timedOut'), cause: result.error.cause } };
      }
      return result;
    } finally {
      clearTimeout(requestState.timeout);
      activeRequestsRef.current.delete(requestState);
    }
  }, [t]);

  const enqueue = useCallback((task: () => Promise<void>) => {
    const lifecycle = lifecycleRef.current;
    const guarded = () => lifecycle === lifecycleRef.current ? task() : Promise.resolve();
    queueRef.current = queueRef.current.then(guarded, guarded);
  }, []);

  const scheduleExpiry = useCallback((expiresAt: number) => {
    clearTimer(expiryTimerRef);
    const remaining = expiresAt - Date.now();
    store.setState({ expired: remaining <= 0 });
    if (remaining > 0) expiryTimerRef.current = setTimeout(() => store.setState({ expired: true }), remaining);
  }, [store]);

  const adoptLease = useCallback((next: AgentSetupLease) => {
    store.setState({ lease: next });
    scheduleExpiry(next.expiresAt);
  }, [scheduleExpiry, store]);

  // A lease answers with the configuration the account last stored. The fields
  // the draft still holds unsaved survive it and are unsaved against it; every
  // other field takes the server's value, and the draft becomes the baseline
  // the next lease is measured from.
  const seedDraft = useCallback((configuration: AgentSetupConfiguration) => {
    store.setState(current => {
      const draft = applyLocalAgentSetupChanges(configuration, current.draft, current.baseline);
      return {
        draft,
        baseline: draft,
        generation: comparableConfiguration(draft) === comparableConfiguration(configuration) ? 0 : 1,
        confirmedGeneration: 0,
      };
    });
  }, [store]);

  const markTerminated = useCallback(() => {
    store.setState({ terminated: true });
    clearTimer(debounceTimerRef);
    clearTimer(saveRetryTimerRef);
    clearTimer(heartbeatTimerRef);
    clearTimer(expiryTimerRef);
  }, [store]);

  const scheduleSaveRetry = useCallback(() => {
    clearTimer(saveRetryTimerRef);
    if (store.getState().terminated) return;
    saveRetryTimerRef.current = setTimeout(() => enqueue(runSaveRef.current), RETRY_DELAY_MS);
  }, [enqueue, store]);

  const scheduleHeartbeat = useCallback((delay: number) => {
    clearTimer(heartbeatTimerRef);
    if (store.getState().terminated || document.visibilityState === 'hidden') return;
    heartbeatTimerRef.current = setTimeout(() => enqueue(heartbeatRef.current), delay);
  }, [enqueue, store]);

  const runSave = useCallback(async () => {
    const { confirmedGeneration, draft, generation, lease, terminated } = store.getState();
    if (!lease || terminated || generation === confirmedGeneration) return;
    const sentGeneration = generation;
    const lifecycle = lifecycleRef.current;
    const sentConfiguration = cloneAgentSetupConfiguration(draft);
    const result = await request(signal => api.api.setup.$put({
      json: {
        token: lease.token,
        configuration: sentConfiguration,
        expectedRevision: lease.configurationRevision,
      },
    }, { init: { signal } }));
    if (lifecycle !== lifecycleRef.current) return;
    if (result.error) {
      const failure = result.error.raw;
      if (failure && 'status' in failure) {
        if (failure.status === 'missing') { markTerminated(); return; }
        if (failure.status === 'revision-conflict') {
          const current: AgentSetupLease = { ...failure, status: 'ok' };
          adoptLease(current);
          if (store.getState().generation === sentGeneration
            && comparableConfiguration(current.configuration) === comparableConfiguration(sentConfiguration)) {
            store.setState({ baseline: sentConfiguration, confirmedGeneration: sentGeneration, saveError: null });
            return;
          }
          clearTimer(debounceTimerRef);
          enqueue(runSaveRef.current);
          return;
        }
      }
      store.setState({ saveError: result.error.message });
      if (isRetryableStatus(result.error.status)) scheduleSaveRetry();
      return;
    }
    clearTimer(saveRetryTimerRef);
    adoptLease(result.data);
    store.setState(current => ({
      saveError: null,
      // The stored configuration is no longer an unsaved edit, so it leaves the
      // set the next lease carries over: without this the fields edited under
      // one key would be copied onto the configuration of the next.
      baseline: sentConfiguration,
      confirmedGeneration: Math.max(current.confirmedGeneration, sentGeneration),
    }));
  }, [adoptLease, enqueue, markTerminated, request, scheduleSaveRetry, store]);
  useEffect(() => { runSaveRef.current = runSave; }, [runSave]);

  const runHeartbeat = useCallback(async () => {
    const { lease, terminated } = store.getState();
    if (!lease || terminated || document.visibilityState === 'hidden') return;
    const lifecycle = lifecycleRef.current;
    const result = await request(signal => api.api.setup.heartbeat.$post({
      json: { token: lease.token },
    }, { init: { signal } }));
    if (lifecycle !== lifecycleRef.current) return;
    if (result.error) {
      const failure = result.error.raw;
      if (failure && 'status' in failure && failure.status === 'missing') { markTerminated(); return; }
      store.setState({ heartbeatError: result.error.message });
      if (isRetryableStatus(result.error.status)) scheduleHeartbeat(RETRY_DELAY_MS);
      return;
    }
    adoptLease(result.data);
    store.setState({ heartbeatError: null });
    scheduleHeartbeat(HEARTBEAT_INTERVAL_MS);
  }, [adoptLease, markTerminated, request, scheduleHeartbeat, store]);
  useEffect(() => { heartbeatRef.current = runHeartbeat; }, [runHeartbeat]);

  useEffect(() => {
    const lifecycle = ++lifecycleRef.current;
    abortRequests();
    clearTimer(debounceTimerRef);
    clearTimer(saveRetryTimerRef);
    clearTimer(heartbeatTimerRef);
    clearTimer(expiryTimerRef);
    queueRef.current = Promise.resolve();
    const loaded = createAttempt === 0 && initialResourceRef.current?.apiKeyId === apiKeyId
      ? initialResourceRef.current
      : null;
    // Discarding here rather than on the adopting pass keeps a re-entered
    // lifecycle for the same key idempotent.
    if (!loaded) initialResourceRef.current = null;
    // The draft and its baseline deliberately survive the teardown: the form
    // keeps showing the configuration it is showing until a lease answers for
    // the new key, and anything edited in the meantime is still measured
    // against the baseline and merged over what that lease brings.
    store.setState({
      lease: null,
      generation: 0,
      confirmedGeneration: 0,
      terminated: false,
      expired: false,
      noSelectableKey: false,
      createError: loaded?.error ?? null,
      saveError: null,
      heartbeatError: null,
    });
    const cleanup = () => {
      lifecycleRef.current += 1;
      abortRequests();
    };
    if (!apiKeyId) return cleanup;
    if (loaded?.lease) {
      adoptLease(loaded.lease);
      seedDraft(loaded.lease.configuration);
      scheduleHeartbeat(HEARTBEAT_INTERVAL_MS);
      return cleanup;
    }
    if (loaded?.error) return cleanup;
    void (async () => {
      const result = await request(signal => api.api.setup.$post({
        json: { apiKeyId },
      }, { init: { signal } }));
      if (lifecycle !== lifecycleRef.current) return;
      if (result.error) {
        const failure = result.error.raw;
        if (failure && 'status' in failure && failure.status === 'no-selectable-key') store.setState({ noSelectableKey: true });
        else store.setState({ createError: result.error.message });
        return;
      }
      adoptLease(result.data);
      seedDraft(result.data.configuration);
      scheduleHeartbeat(HEARTBEAT_INTERVAL_MS);
    })();
    return cleanup;
  }, [abortRequests, adoptLease, apiKeyId, createAttempt, request, scheduleHeartbeat, seedDraft, store]);

  // Watching the lease object would restart the debounce window on every
  // heartbeat, which adopts a freshly issued lease; only an edit may.
  const hasLease = session.lease !== null;
  const { confirmedGeneration, generation, terminated } = session;
  useEffect(() => {
    if (!hasLease || generation === confirmedGeneration || terminated) return;
    clearTimer(debounceTimerRef);
    debounceTimerRef.current = setTimeout(() => enqueue(runSaveRef.current), SAVE_DEBOUNCE_MS);
    return () => clearTimer(debounceTimerRef);
  }, [confirmedGeneration, enqueue, generation, hasLease, terminated]);

  useEffect(() => {
    const onVisibility = () => {
      if (document.visibilityState === 'hidden') {
        clearTimer(heartbeatTimerRef);
        return;
      }
      const state = store.getState();
      if (!state.lease || state.terminated) return;
      if (state.generation !== state.confirmedGeneration) {
        clearTimer(debounceTimerRef);
        enqueue(runSaveRef.current);
      }
      enqueue(heartbeatRef.current);
    };
    document.addEventListener('visibilitychange', onVisibility);
    return () => document.removeEventListener('visibilitychange', onVisibility);
  }, [enqueue, store]);

  useEffect(() => () => {
    lifecycleRef.current += 1;
    abortRequests();
    clearTimer(debounceTimerRef);
    clearTimer(saveRetryTimerRef);
    clearTimer(heartbeatTimerRef);
    clearTimer(expiryTimerRef);
  }, [abortRequests]);

  const updateDraft = useCallback((update: (current: AgentSetupConfiguration) => AgentSetupConfiguration) => {
    const state = store.getState();
    if (state.terminated) return;
    const next = update(cloneAgentSetupConfiguration(state.draft));
    if (comparableConfiguration(state.draft) === comparableConfiguration(next)) return;
    store.setState(current => ({ draft: next, generation: current.generation + 1 }));
  }, [store]);

  const retryCreate = useCallback(() => {
    if (!apiKeyId || store.getState().lease) return;
    abortRequests();
    store.setState({ createError: null, noSelectableKey: false });
    setCreateAttempt(value => value + 1);
  }, [abortRequests, apiKeyId, store]);

  const dismissError = useCallback(() => {
    store.setState({ saveError: null, heartbeatError: null, createError: null });
  }, [store]);

  const { createError, draft, lease, noSelectableKey } = session;
  const syncing = generation !== confirmedGeneration;
  const canCopy = !!lease && !syncing && !terminated && !session.expired && draft.apiKeyId === apiKeyId;
  const error = session.saveError ?? session.heartbeatError ?? createError;
  return useMemo(() => ({
    lease,
    draft,
    error,
    createError,
    dismissError,
    terminated,
    noSelectableKey,
    syncing,
    canCopy,
    updateDraft,
    retryCreate,
  }), [canCopy, createError, dismissError, draft, error, lease, noSelectableKey, retryCreate, syncing, terminated, updateDraft]);
};
