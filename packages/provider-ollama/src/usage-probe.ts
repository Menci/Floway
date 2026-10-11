// Ollama account usage history and current cloud balance use separate APIs.
// GET /api/usage reports activity; GET /api/balance reports remaining quota.
// https://github.com/ollama/ollama/blob/eab97e9f92b9a25c2d52d2cc6c1b1c99bd9fae21/docs/api/cloud-usage.mdx
// https://github.com/ollama/ollama/blob/eab97e9f92b9a25c2d52d2cc6c1b1c99bd9fae21/docs/api/balance.mdx

import { readOllamaAccountUsage } from './account-usage.ts';
import { assertOllamaUpstreamRecord, type OllamaUpstreamConfig } from './config.ts';
import { ollamaFetchUsage, ollamaFetchBalance } from './fetch.ts';
import { type OllamaUsageObservation, type OllamaUpstreamState, readOllamaUpstreamState } from './state.ts';
import { type Fetcher, getProviderRepo, identityWrapUpstreamCall, runScheduledUsageRefresh, type ProviderScheduledOptions, type UpstreamRecord } from '@floway-dev/provider';

// Reading account usage takes two things the operator states: that this upstream
// is an Ollama Cloud account (`cloudUsage` — the endpoint belongs to
// ollama.com, and a base URL cannot settle it, since the cloud may be reached
// through the operator's own domain), and a key to authenticate with.
export const isOllamaUsageEnabled = (config: OllamaUpstreamConfig): boolean =>
  config.cloudUsage && config.apiKey !== undefined;

// Ollama recommends one-minute polling; request-triggered refreshes share
// that cadence.
// https://github.com/ollama/ollama/blob/eab97e9f92b9a25c2d52d2cc6c1b1c99bd9fae21/docs/api/cloud-usage.mdx
export const OLLAMA_USAGE_PROBE_MIN_INTERVAL_MS = 60_000;

const readOllamaObservation = async (response: Response, path: string): Promise<Record<string, unknown>> => {
  const rawText = await response.text();
  if (!response.ok) throw new Error(`Ollama ${path} returned ${response.status}: ${rawText.trim().slice(0, 256)}`);
  let parsed: unknown;
  try {
    parsed = JSON.parse(rawText);
  } catch (cause) {
    throw new Error(`Ollama ${path} returned a non-JSON body (${response.status})`, { cause });
  }
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) throw new Error(`Ollama ${path} returned a non-object body (${response.status})`);
  return parsed as Record<string, unknown>;
};

// A single outcome commits both upstream bodies. Failed reads retain the last
// successful pair, and older attempts cannot replace a newer observation.
const persistUsageReading = async (upstreamId: string, attemptedAt: number, observation: OllamaUsageObservation | null, error: string | null): Promise<void> => {
  await getProviderRepo().upstreams.saveState(upstreamId, current => {
    const state = readOllamaUpstreamState(current);
    if (state.usageProbe && state.usageProbe.attemptedAt > attemptedAt) return current;
    return { ...state, usageProbe: { attemptedAt, observation: observation ?? state.usageProbe?.observation ?? null, error } } satisfies OllamaUpstreamState;
  });
};

export const refreshOllamaUsageProbe = async (upstreamId: string, config: OllamaUpstreamConfig, fetcher: Fetcher): Promise<OllamaUsageObservation> => {
  const attemptedAt = Date.now();
  let observation: OllamaUsageObservation;
  try {
    const init = { method: 'GET', headers: new Headers({ accept: 'application/json' }) };
    const options = { fetcher, wrapUpstreamCall: identityWrapUpstreamCall };
    const [usage, balance] = await Promise.all([
      ollamaFetchUsage(config, init, options).then(response => readOllamaObservation(response, '/api/usage')),
      ollamaFetchBalance(config, init, options).then(response => readOllamaObservation(response, '/api/balance')),
    ]);
    const data = { usage, balance };
    readOllamaAccountUsage(data);
    observation = { fetchedAt: Date.now(), data };
  } catch (error) {
    if (upstreamId !== '') {
      try {
        await persistUsageReading(upstreamId, attemptedAt, null, error instanceof Error ? error.message : String(error));
      } catch (persistenceError) {
        throw new AggregateError([error, persistenceError], 'Ollama usage refresh and outcome persistence failed');
      }
    }
    throw error;
  }
  if (upstreamId !== '') await persistUsageReading(upstreamId, attemptedAt, observation, null);
  return observation;
};

const isOllamaUsageProbeDue = (state: OllamaUpstreamState, now: number): boolean => {
  const probe = state.usageProbe;
  return probe === null || now - probe.attemptedAt >= OLLAMA_USAGE_PROBE_MIN_INTERVAL_MS;
};

// A dashboard refresh must not replace the model response with its failure.
// Record the error on the paired reading and extend the runtime with waitUntil
// so persistence can finish after the response is relayed.
export const scheduleOllamaUsageProbe = (
  upstreamId: string,
  config: OllamaUpstreamConfig,
  state: OllamaUpstreamState,
  fetcher: Fetcher,
  waitUntil: (promise: Promise<unknown>) => void,
): void => {
  if (!isOllamaUsageEnabled(config)) return;
  if (!isOllamaUsageProbeDue(state, Date.now())) return;
  waitUntil(refreshOllamaUsageProbe(upstreamId, config, fetcher).catch((error: unknown) => {
    console.warn(`Failed to refresh Ollama usage for ${upstreamId}:`, error);
  }));
};

export const runOllamaScheduledTask = async (record: UpstreamRecord, options: ProviderScheduledOptions): Promise<void> => {
  const { config } = assertOllamaUpstreamRecord(record);
  if (!isOllamaUsageEnabled(config)) return;
  const state = readOllamaUpstreamState(record.state);
  await runScheduledUsageRefresh(record, options, state.usageProbe?.observation?.fetchedAt ?? null, async (fresh, fetcher) => {
    await refreshOllamaUsageProbe(fresh.id, config, fetcher);
  });
};
