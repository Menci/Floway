import { useCallback, useEffect, useMemo, useRef, useState } from "react";

import { authFetch, callApi } from "../../api/auth";

export interface AgentSetupConfiguration {
  apiKeyId: string;
  claudeCode: {
    model: string | null;
    defaultOpusModel: string | null;
    defaultSonnetModel: string | null;
    defaultHaikuModel: string | null;
    effortLevel: "low" | "medium" | "high" | "xhigh" | null;
    cleanupPeriodDays: 180 | 365 | 99999 | null;
    optOutAiAttribution: boolean;
    modelDiscovery: boolean;
  };
  codex: { model: string | null; reasoningEffort: string | null };
}

interface AgentSetupLease {
  status: "ok";
  token: string;
  configuration: AgentSetupConfiguration;
  configurationRevision: number;
  expiresAt: number;
  scripts: {
    claude: { sh: string; ps1: string };
    codex: { sh: string; ps1: string };
  };
}

const SAVE_DEBOUNCE_MS = 400;
const HEARTBEAT_INTERVAL_MS = 60_000;
const RETRY_DELAY_MS = 15_000;
const REQUEST_TIMEOUT_MS = 20_000;

const clone = <T,>(value: T): T => structuredClone(value);
const rawStatus = (raw: unknown) => raw && typeof raw === "object" && typeof (raw as { status?: unknown }).status === "string"
  ? (raw as { status: string }).status : null;
const leaseFromRaw = (raw: unknown): AgentSetupLease | null => {
  if (!raw || typeof raw !== "object") return null;
  const lease = raw as Partial<AgentSetupLease>;
  return lease.status === "ok" && typeof lease.token === "string" && typeof lease.configurationRevision === "number"
    && typeof lease.expiresAt === "number" && lease.configuration && lease.scripts
    ? lease as AgentSetupLease : null;
};

export const agentSetupCommand = (origin: string, path: string, platform: "unix" | "windows") => platform === "unix"
  ? `export SETUP_ENDPOINT='${origin.replaceAll("'", "'\\''")}'; curl -fsSL "$SETUP_ENDPOINT${path}" | bash`
  : `$SetupEndpoint = '${origin.replaceAll("'", "''")}'; irm "$SetupEndpoint${path}" | iex`;

export function useAgentSetup(apiKeyId: string | null) {
  const [lease, setLease] = useState<AgentSetupLease | null>(null);
  const [draft, setDraftState] = useState<AgentSetupConfiguration | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [terminated, setTerminated] = useState(false);
  const [noSelectableKey, setNoSelectableKey] = useState(false);
  const [generation, setGeneration] = useState(0);
  const [confirmedGeneration, setConfirmedGeneration] = useState(0);
  const [now, setNow] = useState(Date.now());
  const [createAttempt, setCreateAttempt] = useState(0);
  const lifecycleRef = useRef(0);
  const leaseRef = useRef<AgentSetupLease | null>(null);
  const draftRef = useRef<AgentSetupConfiguration | null>(null);
  const generationRef = useRef(0);
  const confirmedRef = useRef(0);
  const queueRef = useRef(Promise.resolve());
  const retryTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  const adoptLease = useCallback((next: AgentSetupLease) => {
    leaseRef.current = next;
    setLease(next);
    setNow(Date.now());
  }, []);

  const request = useCallback(async <T,>(path: string, method: string, body: unknown) => {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
    try {
      return await callApi<T>(() => authFetch(path, {
        method,
        headers: { "content-type": "application/json" },
        body: JSON.stringify(body),
        signal: controller.signal,
      }));
    } finally {
      clearTimeout(timer);
    }
  }, []);

  const enqueue = useCallback((task: () => Promise<void>) => {
    queueRef.current = queueRef.current.then(task, task);
  }, []);

  const runSave = useCallback(async () => {
    const currentLease = leaseRef.current;
    const configuration = draftRef.current;
    if (!currentLease || !configuration || terminated) return;
    const sentGeneration = generationRef.current;
    const result = await request<AgentSetupLease>("/api/setup", "PUT", {
      token: currentLease.token,
      configuration: clone(configuration),
      expectedRevision: currentLease.configurationRevision,
    });
    if (leaseRef.current?.token !== currentLease.token) return;
    if (result.error) {
      const status = rawStatus(result.error.raw);
      if (status === "missing") { setTerminated(true); return; }
      if (status === "revision-conflict") {
        const current = leaseFromRaw({ ...(result.error.raw as object), status: "ok" });
        if (current) {
          adoptLease(current);
          enqueue(runSave);
          return;
        }
      }
      setError(result.error.message);
      if (result.error.status === 0 || result.error.status === 408 || result.error.status === 429 || result.error.status >= 500) {
        if (retryTimerRef.current) clearTimeout(retryTimerRef.current);
        retryTimerRef.current = setTimeout(() => enqueue(runSave), RETRY_DELAY_MS);
      }
      return;
    }
    adoptLease(result.data);
    setError(null);
    if (sentGeneration > confirmedRef.current) {
      confirmedRef.current = sentGeneration;
      setConfirmedGeneration(sentGeneration);
    }
  }, [adoptLease, enqueue, request, terminated]);

  useEffect(() => {
    const lifecycle = ++lifecycleRef.current;
    if (retryTimerRef.current) {
      clearTimeout(retryTimerRef.current);
      retryTimerRef.current = null;
    }
    leaseRef.current = null;
    draftRef.current = null;
    generationRef.current = 0;
    confirmedRef.current = 0;
    setLease(null);
    setDraftState(null);
    setGeneration(0);
    setConfirmedGeneration(0);
    setError(null);
    setTerminated(false);
    setNoSelectableKey(false);
    if (!apiKeyId) return;
    void (async () => {
      const result = await request<AgentSetupLease>("/api/setup", "POST", { apiKeyId });
      if (lifecycle !== lifecycleRef.current) return;
      if (result.error) {
        if (rawStatus(result.error.raw) === "no-selectable-key") setNoSelectableKey(true);
        else setError(result.error.message);
        return;
      }
      adoptLease(result.data);
      const configuration = clone(result.data.configuration);
      draftRef.current = configuration;
      setDraftState(configuration);
    })();
    return () => { lifecycleRef.current += 1; };
  }, [adoptLease, apiKeyId, createAttempt, request]);

  useEffect(() => {
    if (!lease || !draft || generation === confirmedGeneration || terminated) return;
    const timer = setTimeout(() => enqueue(runSave), SAVE_DEBOUNCE_MS);
    return () => clearTimeout(timer);
  }, [confirmedGeneration, draft, enqueue, generation, lease, runSave, terminated]);

  useEffect(() => {
    if (!lease || terminated) return;
    const heartbeat = () => enqueue(async () => {
      const current = leaseRef.current;
      if (!current || document.visibilityState === "hidden") return;
      const result = await request<AgentSetupLease>("/api/setup/heartbeat", "POST", { token: current.token });
      if (leaseRef.current?.token !== current.token) return;
      if (result.error) {
        if (rawStatus(result.error.raw) === "missing") setTerminated(true);
        else setError(result.error.message);
        return;
      }
      adoptLease(result.data);
      setError(null);
    });
    const interval = setInterval(heartbeat, HEARTBEAT_INTERVAL_MS);
    const onVisibility = () => {
      setNow(Date.now());
      if (document.visibilityState === "visible") heartbeat();
    };
    document.addEventListener("visibilitychange", onVisibility);
    return () => {
      clearInterval(interval);
      document.removeEventListener("visibilitychange", onVisibility);
    };
  }, [adoptLease, enqueue, lease?.token, request, terminated]);

  useEffect(() => () => {
    if (retryTimerRef.current) clearTimeout(retryTimerRef.current);
  }, []);

  const updateDraft = useCallback((update: (current: AgentSetupConfiguration) => AgentSetupConfiguration) => {
    const current = draftRef.current;
    if (!current || terminated) return;
    const next = update(clone(current));
    draftRef.current = next;
    const nextGeneration = generationRef.current + 1;
    generationRef.current = nextGeneration;
    setGeneration(nextGeneration);
    setDraftState(next);
  }, [terminated]);

  const retryCreate = useCallback(() => {
    if (!apiKeyId) return;
    lifecycleRef.current += 1;
    setError(null);
    setNoSelectableKey(false);
    setLease(null);
    setDraftState(null);
    setCreateAttempt((value) => value + 1);
  }, [apiKeyId]);

  const syncing = generation !== confirmedGeneration;
  const canCopy = !!lease && !!draft && !syncing && !terminated && lease.expiresAt > now && draft.apiKeyId === apiKeyId;
  return useMemo(() => ({ lease, draft, error, terminated, noSelectableKey, syncing, canCopy, updateDraft, retryCreate }),
    [canCopy, draft, error, lease, noSelectableKey, retryCreate, syncing, terminated, updateDraft]);
}
