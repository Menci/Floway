// Ollama Cloud account usage probe.
//
// ollama.com serves `GET /api/usage` behind the same API key the data plane
// already uses. It answers with the account's rolling session window, its
// weekly window, per-model request counts, and an `activity` block over a
// trailing four-week period:
//
//   {"activity": {"cost": "0.00000",
//                 "period": {"type": "last_4_weeks", "starting_at": "...", "ending_at": "..."},
//                 "models": []},
//    "limits": {"session": {"usage": 0.046, "models": [{"name": "...", "request_count": 34}]},
//               "weekly":  {"usage": 0.051, "models": [...]}}}
//
// The endpoint is real but unannounced: it is absent from docs.ollama.com
// (whose `/api/usage` page documents per-response performance counters, an
// unrelated surface), and the request for it is still open upstream. An Ollama
// maintainer pointed users at it on 2026-07-29, and the response body above is
// the reading an account holder posted back in the same thread — the closest
// thing to a specification it has.
// https://github.com/ollama/ollama/issues/12532#issuecomment-5117276581
// https://github.com/ollama/ollama/issues/12532#issuecomment-5117969589
//
// Because it is unannounced, the body is persisted verbatim and the dashboard
// walks the keys it knows — the per-model rows have already been reported under
// two different field namings, so a strict parser would reject a live account.
// The response carries no reset timestamps, so a window is a percentage only.
//
// Nothing equivalent rides on the inference responses: Ollama Cloud sends no
// rate-limit headers (its documented error contract is a bare 429 with a JSON
// `error` string), so an active probe is the only way to observe the windows.
// https://github.com/ollama/ollama/blob/f0078ae4766d0d570e196158f20dde309bd96124/docs/api/errors.mdx

import { type OllamaUpstreamConfig } from './config.ts';
import { ollamaFetchUsage } from './fetch.ts';
import { type OllamaUsageObservation, type OllamaUsageProbeEntry, type OllamaUpstreamState, readOllamaUpstreamState } from './state.ts';
import { type Fetcher, getProviderRepo, identityWrapUpstreamCall } from '@floway-dev/provider';

// The usage endpoint is served by ollama.com, not by the Ollama binary: a
// self-hosted daemon has no account and answers 404. Probing is therefore
// gated on the upstream actually pointing at the cloud, which also keeps a
// keyless private daemon off the path entirely.
const OLLAMA_CLOUD_HOSTNAME = 'ollama.com';

export const isOllamaCloudConfig = (config: OllamaUpstreamConfig): boolean => {
  if (config.apiKey === undefined) return false;
  return new URL(config.baseUrl).hostname === OLLAMA_CLOUD_HOSTNAME;
};

// Both windows are hours-to-days wide and the payload is a fixed cost per
// probe, so this is the resolution worth paying for: a busy upstream refreshes
// once a minute, an idle one not at all.
export const OLLAMA_USAGE_PROBE_MIN_INTERVAL_MS = 60_000;

export const fetchOllamaUsageProbe = async (
  config: OllamaUpstreamConfig,
  fetcher: Fetcher,
): Promise<OllamaUsageObservation> => {
  const response = await ollamaFetchUsage(
    config,
    { method: 'GET', headers: new Headers({ accept: 'application/json' }) },
    { fetcher, wrapUpstreamCall: identityWrapUpstreamCall },
  );
  const rawText = await response.text();
  if (!response.ok) {
    throw new Error(`Ollama /api/usage returned ${response.status}: ${rawText.slice(0, 256)}`);
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(rawText);
  } catch (cause) {
    throw new Error(`Ollama /api/usage returned a non-JSON body (${response.status})`, { cause: cause as Error });
  }
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    throw new Error(`Ollama /api/usage returned a non-object body (${response.status})`);
  }
  return { fetchedAt: Date.now(), data: parsed };
};

// The entry is written under saveState's read-modify-CAS, and the mutator is
// re-run against whoever won a concurrent write. Two probes racing therefore
// resolve by attempt time rather than by write order, so the loser of the race
// cannot roll the slot back to its older reading.
const persistProbeEntry = async (upstreamId: string, entry: OllamaUsageProbeEntry): Promise<void> => {
  await getProviderRepo().upstreams.saveState(upstreamId, current => {
    const state = readOllamaUpstreamState(current);
    if (state.usageProbe && state.usageProbe.attemptedAt >= entry.attemptedAt) return current;
    return {
      ...state,
      usageProbe: {
        attemptedAt: entry.attemptedAt,
        // A failed probe keeps the last good reading rather than blanking the
        // card; only a success replaces it.
        observation: entry.observation ?? state.usageProbe?.observation ?? null,
        error: entry.error,
      },
    } satisfies OllamaUpstreamState;
  });
};

// Runs the probe and records its outcome. Used directly by the operator's
// refresh action, which wants the failure to travel back to the dashboard, and
// through `scheduleOllamaUsageProbe` by the data plane, which does not.
export const refreshOllamaUsageProbe = async (
  upstreamId: string,
  config: OllamaUpstreamConfig,
  fetcher: Fetcher,
): Promise<OllamaUsageObservation> => {
  const attemptedAt = Date.now();
  let observation: OllamaUsageObservation;
  try {
    observation = await fetchOllamaUsageProbe(config, fetcher);
  } catch (error) {
    await persistProbeEntry(upstreamId, {
      attemptedAt,
      observation: null,
      error: error instanceof Error ? error.message : String(error),
    });
    throw error;
  }
  await persistProbeEntry(upstreamId, { attemptedAt, observation, error: null });
  return observation;
};

const isOllamaUsageProbeDue = (state: OllamaUpstreamState, now: number): boolean => {
  const probe = state.usageProbe;
  return probe === null || now - probe.attemptedAt >= OLLAMA_USAGE_PROBE_MIN_INTERVAL_MS;
};

// Fire-and-forget refresh behind the debounce, scheduled by the data plane
// once an upstream call that consumes the account's windows has been made.
// Every read the debounce needs is already in hand: `state` is the record this
// request was routed with, which the repo reads per request, so a probe that is
// not due costs nothing at all.
//
// Best-effort by construction: the response is already the caller's, and a
// usage card is strictly better-than-nothing information. A failure is
// recorded on the upstream — where the operator sees it — and never reaches
// the request.
export const scheduleOllamaUsageProbe = (
  upstreamId: string,
  config: OllamaUpstreamConfig,
  state: OllamaUpstreamState,
  fetcher: Fetcher,
  waitUntil: (promise: Promise<unknown>) => void,
): void => {
  if (!isOllamaCloudConfig(config)) return;
  if (!isOllamaUsageProbeDue(state, Date.now())) return;
  waitUntil(refreshOllamaUsageProbe(upstreamId, config, fetcher).catch((error: unknown) => {
    console.warn(`Failed to refresh Ollama usage for ${upstreamId}:`, error);
  }));
};
