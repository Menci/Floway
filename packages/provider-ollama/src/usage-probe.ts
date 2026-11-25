// Ollama account usage history and current cloud balance use separate APIs.
// GET /api/usage reports activity; GET /api/balance reports remaining quota.
// https://github.com/ollama/ollama/blob/eab97e9f92b9a25c2d52d2cc6c1b1c99bd9fae21/docs/api/cloud-usage.mdx
// https://github.com/ollama/ollama/blob/eab97e9f92b9a25c2d52d2cc6c1b1c99bd9fae21/docs/api/balance.mdx

import { parseOllamaAccountUsage } from './account-usage.ts';
import { fetchOllamaApi } from './api.ts';
import { assertOllamaUpstreamRecord, type OllamaUpstreamConfig } from './config.ts';
import { type OllamaUsageObservation, type OllamaUpstreamState, readOllamaUpstreamState } from './state.ts';
import { ollamaMetrics } from './upstream-metrics.ts';
import { readHttpResponseText } from '@floway-dev/http';
import type { Result } from '@floway-dev/pipeline';
import { getProviderRepo, normalizeUpstreamMetricIdentity, runScheduledUsageRefresh, type ProviderRepo, type ProviderScheduledOptions, type ProviderServices, type UpstreamRecord } from '@floway-dev/provider';

// Reading account usage takes two things the operator states: that this upstream
// is an Ollama Cloud account (`cloudUsage` — the endpoint belongs to
// ollama.com, and a base URL cannot settle it, since the cloud may be reached
// through the operator's own domain), and a key to authenticate with.
export const isOllamaUsageEnabled = (config: { readonly cloudUsage: boolean; readonly apiKey?: unknown }): boolean =>
  config.cloudUsage && config.apiKey !== undefined;

// Ollama recommends one-minute polling; request-triggered refreshes share
// that cadence.
// https://github.com/ollama/ollama/blob/eab97e9f92b9a25c2d52d2cc6c1b1c99bd9fae21/docs/api/cloud-usage.mdx
export const OLLAMA_USAGE_PROBE_MIN_INTERVAL_MS = 60_000;

const readOllamaObservation = async (result: Awaited<ReturnType<typeof fetchOllamaApi>>, path: string): Promise<Result<Record<string, unknown>, unknown>> => {
  if (!result.ok) return { ok: false, error: result.error.cause };
  const response = result.value;
  const rawText = await readHttpResponseText(response);
  if (!rawText.ok) return { ok: false, error: rawText.error.cause };
  if (!response.ok) return { ok: false, error: new Error(`Ollama ${path} returned ${response.status}: ${rawText.value.trim().slice(0, 256)}`) };
  let parsed: unknown;
  try {
    parsed = JSON.parse(rawText.value);
  } catch (cause) {
    if (!(cause instanceof SyntaxError)) throw cause;
    return { ok: false, error: new Error(`Ollama ${path} returned a non-JSON body (${response.status})`, { cause }) };
  }
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) return { ok: false, error: new Error(`Ollama ${path} returned a non-object body (${response.status})`) };
  return { ok: true, value: parsed as Record<string, unknown> };
};

// A single outcome commits both upstream bodies. Failed reads retain the last
// successful pair, and older attempts cannot replace a newer observation.
const persistUsageReading = async (
  repo: ProviderRepo,
  upstreamId: string,
  attemptedAt: number,
  observation: OllamaUsageObservation | null,
  error: string | null,
  expectedConfigVersion?: number,
): Promise<Result<void, unknown>> => {
  let accepted = false;
  try {
    await repo.upstreams.saveState(upstreamId, (current, configVersion) => {
      accepted = false;
      if (expectedConfigVersion !== undefined && configVersion !== expectedConfigVersion) return current;
      const state = readOllamaUpstreamState(current);
      if (state.usageProbe && state.usageProbe.attemptedAt > attemptedAt) return current;
      accepted = true;
      return { ...state, usageProbe: { attemptedAt, observation: observation ?? state.usageProbe?.observation ?? null, error } } satisfies OllamaUpstreamState;
    });
  } catch (error) {
    return { ok: false, error };
  }
  if (accepted && observation !== null) {
    const metrics = ollamaMetrics(observation.data).map(metric => ({ ...normalizeUpstreamMetricIdentity(metric.name, metric.labels), value: metric.value }));
    try {
      await Promise.all(metrics.map(({ name, labels, value }) => repo.recordUpstreamMetric(upstreamId, name, labels, value, observation.fetchedAt)));
    } catch (error) {
      return { ok: false, error };
    }
  }
  return { ok: true, value: undefined };
};

export const refreshOllamaUsageProbe = async (
  upstreamId: string,
  config: OllamaUpstreamConfig,
  fetcher: ReturnType<ProviderServices['fetcher']>,
  repo?: ProviderRepo,
  expectedConfigVersion?: number,
): Promise<Result<OllamaUsageObservation, unknown>> => {
  const attemptedAt = Date.now();
  const init = { method: 'GET', headers: new Headers({ accept: 'application/json' }) };
  const [usage, balance] = await Promise.all([
    fetchOllamaApi(config, '/api/usage', init, fetcher).then(response => readOllamaObservation(response, '/api/usage')),
    fetchOllamaApi(config, '/api/balance', init, fetcher).then(response => readOllamaObservation(response, '/api/balance')),
  ]);
  let outcome: Result<OllamaUsageObservation, unknown>;
  if (!usage.ok) outcome = usage;
  else if (!balance.ok) outcome = balance;
  else {
    const data = { usage: usage.value, balance: balance.value };
    const parsed = parseOllamaAccountUsage(data);
    outcome = parsed.ok ? { ok: true, value: { fetchedAt: Date.now(), data } } : parsed;
  }
  if (upstreamId === '') return outcome;
  const persistence = repo ?? getProviderRepo();
  if (outcome.ok) {
    const persisted = await persistUsageReading(persistence, upstreamId, attemptedAt, outcome.value, null, expectedConfigVersion);
    return persisted.ok ? outcome : persisted;
  }
  const { error } = outcome;
  const message = error instanceof Error ? error.message : String(error);
  const persisted = await persistUsageReading(persistence, upstreamId, attemptedAt, null, message, expectedConfigVersion);
  return persisted.ok ? outcome : { ok: false, error: new AggregateError([error, persisted.error], 'Ollama usage refresh and outcome persistence failed') };
};

export const isOllamaUsageProbeDue = (state: OllamaUpstreamState, now: number): boolean => {
  const probe = state.usageProbe;
  return probe === null || now - probe.attemptedAt >= OLLAMA_USAGE_PROBE_MIN_INTERVAL_MS;
};

export const runOllamaScheduledTask = async (record: UpstreamRecord, options: ProviderScheduledOptions<ReturnType<ProviderServices['fetcher']>>): Promise<void> => {
  const { config } = assertOllamaUpstreamRecord(record);
  if (!isOllamaUsageEnabled(config)) return;
  const state = readOllamaUpstreamState(record.state);
  await runScheduledUsageRefresh(record, options, state.usageProbe?.observation?.fetchedAt ?? null, async (fresh, fetcher) => {
    const result = await refreshOllamaUsageProbe(fresh.id, config, fetcher);
    if (!result.ok) throw result.error;
  });
};
