import { useCallback, useEffect, useMemo, useRef, useState } from 'react';

import { authFetch, callApi } from '../../api/auth';

export interface AgentSetupConfiguration {
  apiKeyId: string;
  claudeCode: {
    model: string | null;
    defaultFableModel: string | null;
    defaultOpusModel: string | null;
    defaultSonnetModel: string | null;
    defaultHaikuModel: string | null;
    effortLevel: 'low' | 'medium' | 'high' | 'xhigh' | null;
    cleanupPeriodDays: 180 | 365 | 99999 | null;
    optOutAiAttribution: boolean;
    modelDiscovery: boolean;
  };
  codex: { model: string | null; reasoningEffort: string | null };
}

interface AgentSetupLease {
  status: 'ok';
  token: string;
  configuration: AgentSetupConfiguration;
  configurationRevision: number;
  expiresAt: number;
  scripts: {
    claude: { sh: string; ps1: string };
    codex: { sh: string; ps1: string };
  };
}

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

const clone = <T>(value: T): T => structuredClone(value);
const rawStatus = (raw: unknown) => raw && typeof raw === 'object' && typeof (raw as { status?: unknown }).status === 'string'
  ? (raw as { status: string }).status : null;
const leaseFromRaw = (raw: unknown): AgentSetupLease | null => {
  if (!raw || typeof raw !== 'object') return null;
  const lease = raw as Partial<AgentSetupLease>;
  return lease.status === 'ok' && typeof lease.token === 'string' && typeof lease.configurationRevision === 'number'
    && typeof lease.expiresAt === 'number' && lease.configuration && lease.scripts
    ? lease as AgentSetupLease : null;
};
const isRetryableStatus = (status: number) =>
  status === 0 || status === 408 || status === 429 || status >= 500;
const configurationsEqual = (left: unknown, right: unknown): boolean => {
  if (left === right) return true;
  if (!left || !right || typeof left !== 'object' || typeof right !== 'object') return false;
  const leftRecord = left as Record<string, unknown>;
  const rightRecord = right as Record<string, unknown>;
  const keys = Object.keys(leftRecord);
  return keys.length === Object.keys(rightRecord).length
    && keys.every(key => configurationsEqual(leftRecord[key], rightRecord[key]));
};

export const defaultAgentSetupConfiguration = (apiKeyId = ''): AgentSetupConfiguration => ({
  apiKeyId,
  claudeCode: {
    model: null,
    defaultFableModel: null,
    defaultOpusModel: null,
    defaultSonnetModel: null,
    defaultHaikuModel: null,
    effortLevel: null,
    cleanupPeriodDays: null,
    optOutAiAttribution: false,
    modelDiscovery: true,
  },
  codex: { model: null, reasoningEffort: null },
});

export const agentSetupCommand = (origin: string, path: string, platform: 'unix' | 'windows') => platform === 'unix'
  ? `export SETUP_ENDPOINT='${origin.replaceAll("'", "'\\''")}'; curl -fsSL "$SETUP_ENDPOINT${path}" | bash`
  : `$SetupEndpoint = '${origin.replaceAll("'", "''")}'; irm "$SetupEndpoint${path}" | iex`;

export function useAgentSetup(apiKeyId: string | null) {
  const [lease, setLease] = useState<AgentSetupLease | null>(null);
  const [draft, setDraftState] = useState<AgentSetupConfiguration | null>(null);
  const [createError, setCreateError] = useState<string | null>(null);
  const [saveError, setSaveError] = useState<string | null>(null);
  const [heartbeatError, setHeartbeatError] = useState<string | null>(null);
  const [terminated, setTerminated] = useState(false);
  const [noSelectableKey, setNoSelectableKey] = useState(false);
  const [generation, setGeneration] = useState(0);
  const [confirmedGeneration, setConfirmedGeneration] = useState(0);
  const [expired, setExpired] = useState(false);
  const [createAttempt, setCreateAttempt] = useState(0);

  const lifecycleRef = useRef(0);
  const leaseRef = useRef<AgentSetupLease | null>(null);
  const draftRef = useRef<AgentSetupConfiguration | null>(null);
  const generationRef = useRef(0);
  const confirmedRef = useRef(0);
  const terminatedRef = useRef(false);
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

  const request = useCallback(async <T>(path: string, method: string, body: unknown) => {
    const controller = new AbortController();
    const requestState: ActiveRequest = {
      controller,
      timeout: setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS),
    };
    activeRequestsRef.current.add(requestState);
    try {
      return await callApi<T>(() => authFetch(path, {
        method,
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(body),
        signal: controller.signal,
      }));
    } finally {
      clearTimeout(requestState.timeout);
      activeRequestsRef.current.delete(requestState);
    }
  }, []);

  const enqueue = useCallback((task: () => Promise<void>) => {
    const lifecycle = lifecycleRef.current;
    const guarded = () => lifecycle === lifecycleRef.current ? task() : Promise.resolve();
    queueRef.current = queueRef.current.then(guarded, guarded);
  }, []);

  const scheduleExpiry = useCallback((expiresAt: number) => {
    clearTimer(expiryTimerRef);
    const remaining = expiresAt - Date.now();
    setExpired(remaining <= 0);
    if (remaining > 0) expiryTimerRef.current = setTimeout(() => setExpired(true), remaining);
  }, []);

  const adoptLease = useCallback((next: AgentSetupLease) => {
    leaseRef.current = next;
    setLease(next);
    scheduleExpiry(next.expiresAt);
  }, [scheduleExpiry]);

  const markTerminated = useCallback(() => {
    terminatedRef.current = true;
    setTerminated(true);
    clearTimer(debounceTimerRef);
    clearTimer(saveRetryTimerRef);
    clearTimer(heartbeatTimerRef);
    clearTimer(expiryTimerRef);
  }, []);

  const scheduleSaveRetry = useCallback(() => {
    clearTimer(saveRetryTimerRef);
    if (terminatedRef.current) return;
    saveRetryTimerRef.current = setTimeout(() => enqueue(runSaveRef.current), RETRY_DELAY_MS);
  }, [enqueue]);

  const scheduleHeartbeat = useCallback((delay: number) => {
    clearTimer(heartbeatTimerRef);
    if (terminatedRef.current || document.visibilityState === 'hidden') return;
    heartbeatTimerRef.current = setTimeout(() => enqueue(heartbeatRef.current), delay);
  }, [enqueue]);

  const runSave = useCallback(async () => {
    const currentLease = leaseRef.current;
    const configuration = draftRef.current;
    if (!currentLease || !configuration || terminatedRef.current
      || generationRef.current === confirmedRef.current) return;
    const sentGeneration = generationRef.current;
    const sentConfiguration = clone(configuration);
    const result = await request<AgentSetupLease>('/api/setup', 'PUT', {
      token: currentLease.token,
      configuration: sentConfiguration,
      expectedRevision: currentLease.configurationRevision,
    });
    if (leaseRef.current?.token !== currentLease.token) return;
    if (result.error) {
      const status = rawStatus(result.error.raw);
      if (status === 'missing') { markTerminated(); return; }
      if (status === 'revision-conflict') {
        const current = leaseFromRaw({ ...(result.error.raw as object), status: 'ok' });
        if (!current) {
          setSaveError('Received an unexpected conflict response from the server.');
          return;
        }
        adoptLease(current);
        if (generationRef.current === sentGeneration
          && configurationsEqual(current.configuration, sentConfiguration)) {
          confirmedRef.current = sentGeneration;
          setConfirmedGeneration(sentGeneration);
          setSaveError(null);
          return;
        }
        clearTimer(debounceTimerRef);
        enqueue(runSaveRef.current);
        return;
      }
      setSaveError(result.error.message);
      if (isRetryableStatus(result.error.status)) scheduleSaveRetry();
      return;
    }
    clearTimer(saveRetryTimerRef);
    adoptLease(result.data);
    setSaveError(null);
    if (sentGeneration > confirmedRef.current) {
      confirmedRef.current = sentGeneration;
      setConfirmedGeneration(sentGeneration);
    }
  }, [adoptLease, enqueue, markTerminated, request, scheduleSaveRetry]);
  useEffect(() => { runSaveRef.current = runSave; }, [runSave]);

  const runHeartbeat = useCallback(async () => {
    const currentLease = leaseRef.current;
    if (!currentLease || terminatedRef.current || document.visibilityState === 'hidden') return;
    const result = await request<AgentSetupLease>('/api/setup/heartbeat', 'POST', { token: currentLease.token });
    if (leaseRef.current?.token !== currentLease.token) return;
    if (result.error) {
      if (rawStatus(result.error.raw) === 'missing') { markTerminated(); return; }
      setHeartbeatError(result.error.message);
      if (isRetryableStatus(result.error.status)) scheduleHeartbeat(RETRY_DELAY_MS);
      return;
    }
    adoptLease(result.data);
    setHeartbeatError(null);
    scheduleHeartbeat(HEARTBEAT_INTERVAL_MS);
  }, [adoptLease, markTerminated, request, scheduleHeartbeat]);
  useEffect(() => { heartbeatRef.current = runHeartbeat; }, [runHeartbeat]);

  useEffect(() => {
    const lifecycle = ++lifecycleRef.current;
    abortRequests();
    clearTimer(debounceTimerRef);
    clearTimer(saveRetryTimerRef);
    clearTimer(heartbeatTimerRef);
    clearTimer(expiryTimerRef);
    queueRef.current = Promise.resolve();
    leaseRef.current = null;
    draftRef.current = null;
    generationRef.current = 0;
    confirmedRef.current = 0;
    terminatedRef.current = false;
    // eslint-disable-next-line react-hooks/set-state-in-effect -- A key change tears down one external lease before acquiring another.
    setLease(null);
    setDraftState(null);
    setGeneration(0);
    setConfirmedGeneration(0);
    setCreateError(null);
    setSaveError(null);
    setHeartbeatError(null);
    setTerminated(false);
    setExpired(false);
    setNoSelectableKey(false);
    if (!apiKeyId) return;
    void (async () => {
      const result = await request<AgentSetupLease>('/api/setup', 'POST', { apiKeyId });
      if (lifecycle !== lifecycleRef.current) return;
      if (result.error) {
        if (rawStatus(result.error.raw) === 'no-selectable-key') setNoSelectableKey(true);
        else setCreateError(result.error.message);
        return;
      }
      adoptLease(result.data);
      const configuration = clone(result.data.configuration);
      draftRef.current = configuration;
      setDraftState(configuration);
      scheduleHeartbeat(HEARTBEAT_INTERVAL_MS);
    })();
    return () => {
      lifecycleRef.current += 1;
      abortRequests();
    };
  }, [abortRequests, adoptLease, apiKeyId, createAttempt, request, scheduleHeartbeat]);

  useEffect(() => {
    if (!lease || !draft || generation === confirmedGeneration || terminated) return;
    clearTimer(debounceTimerRef);
    debounceTimerRef.current = setTimeout(() => enqueue(runSaveRef.current), SAVE_DEBOUNCE_MS);
    return () => clearTimer(debounceTimerRef);
  }, [confirmedGeneration, draft, enqueue, generation, lease, terminated]);

  useEffect(() => {
    const onVisibility = () => {
      if (document.visibilityState === 'hidden') {
        clearTimer(heartbeatTimerRef);
        return;
      }
      if (!leaseRef.current || terminatedRef.current) return;
      if (generationRef.current !== confirmedRef.current) {
        clearTimer(debounceTimerRef);
        enqueue(runSaveRef.current);
      }
      enqueue(heartbeatRef.current);
    };
    document.addEventListener('visibilitychange', onVisibility);
    return () => document.removeEventListener('visibilitychange', onVisibility);
  }, [enqueue]);

  useEffect(() => () => {
    lifecycleRef.current += 1;
    abortRequests();
    clearTimer(debounceTimerRef);
    clearTimer(saveRetryTimerRef);
    clearTimer(heartbeatTimerRef);
    clearTimer(expiryTimerRef);
  }, [abortRequests]);

  const updateDraft = useCallback((update: (current: AgentSetupConfiguration) => AgentSetupConfiguration) => {
    const current = draftRef.current;
    if (!current || terminatedRef.current) return;
    const next = update(clone(current));
    draftRef.current = next;
    const nextGeneration = generationRef.current + 1;
    generationRef.current = nextGeneration;
    setGeneration(nextGeneration);
    setDraftState(next);
  }, []);

  const retryCreate = useCallback(() => {
    if (!apiKeyId || leaseRef.current) return;
    abortRequests();
    setCreateError(null);
    setNoSelectableKey(false);
    setCreateAttempt(value => value + 1);
  }, [abortRequests, apiKeyId]);

  const syncing = generation !== confirmedGeneration;
  const canCopy = !!lease && !!draft && !syncing && !terminated && !expired && draft.apiKeyId === apiKeyId;
  const error = saveError ?? heartbeatError ?? createError;
  return useMemo(() => ({
    lease,
    draft,
    error,
    createError,
    terminated,
    noSelectableKey,
    syncing,
    canCopy,
    updateDraft,
    retryCreate,
  }), [canCopy, createError, draft, error, lease, noSelectableKey, retryCreate, syncing, terminated, updateDraft]);
}
