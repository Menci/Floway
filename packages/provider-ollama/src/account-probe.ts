// Ollama Cloud account probe.
//
// ollama.com serves `POST /api/me` behind the same API key the data plane
// already uses, and answers with the account's identity and the plan it is on:
//
//   {"ID": "...", "Email": "...", "Name": "...", "plan": "pro", ...}
//
// The endpoint is undocumented like the usage one beside it, but unlike that
// one it is in the official Go client, which is what names the field and its
// values -- `free`, `pro`, `max`, `team`, with an empty plan meaning free.
// https://github.com/ollama/ollama/blob/f0078ae4766d0d570e196158f20dde309bd96124/api/client.go#L506
// https://github.com/ollama/ollama/blob/f0078ae4766d0d570e196158f20dde309bd96124/server/routes.go#L2207
//
// The live body carries more than `UserResponse` declares -- subscription
// period and billing identifiers, in a different casing -- so only the one
// field this reads is taken, and an account naming no plan reads as naming
// none rather than as free: the defaulting above is the server's, and an
// absent field on the wire is a fact about the response, not about the plan.

import { type OllamaUpstreamConfig } from './config.ts';
import { ollamaFetchMe } from './fetch.ts';
import { type OllamaAccountEntry, type OllamaUpstreamState, readOllamaUpstreamState } from './state.ts';
import { isOllamaCloudConfig } from './usage-probe.ts';
import { type Fetcher, getProviderRepo, identityWrapUpstreamCall } from '@floway-dev/provider';

// A subscription changes on a billing boundary at most, so this is refreshed on
// a wholly different cadence from the usage windows beside it: an upstream
// serving traffic re-reads its plan once a day.
export const OLLAMA_ACCOUNT_PROBE_MIN_INTERVAL_MS = 24 * 60 * 60 * 1000;

export const fetchOllamaAccount = async (
  config: OllamaUpstreamConfig,
  fetcher: Fetcher,
): Promise<OllamaAccountEntry> => {
  const response = await ollamaFetchMe(
    config,
    { method: 'POST', headers: new Headers({ accept: 'application/json' }), body: '{}' },
    { fetcher, wrapUpstreamCall: identityWrapUpstreamCall },
  );
  const rawText = await response.text();
  if (!response.ok) {
    throw new Error(`Ollama /api/me returned ${response.status}: ${rawText.trim().slice(0, 256)}`);
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(rawText);
  } catch (cause) {
    throw new Error(`Ollama /api/me returned a non-JSON body (${response.status})`, { cause: cause as Error });
  }
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    throw new Error(`Ollama /api/me returned a non-object body (${response.status})`);
  }
  const plan = (parsed as Record<string, unknown>).plan;
  return { fetchedAt: Date.now(), plan: typeof plan === 'string' && plan !== '' ? plan : null };
};

const persistAccountEntry = async (upstreamId: string, entry: OllamaAccountEntry): Promise<void> => {
  await getProviderRepo().upstreams.saveState(upstreamId, current => {
    const state = readOllamaUpstreamState(current);
    // Races resolve by read time rather than by write order, as the usage slot
    // beside this one does.
    if (state.account && state.account.fetchedAt >= entry.fetchedAt) return current;
    return { ...state, account: entry } satisfies OllamaUpstreamState;
  });
};

export const refreshOllamaAccount = async (
  upstreamId: string,
  config: OllamaUpstreamConfig,
  fetcher: Fetcher,
): Promise<OllamaAccountEntry> => {
  const entry = await fetchOllamaAccount(config, fetcher);
  await persistAccountEntry(upstreamId, entry);
  return entry;
};

const isOllamaAccountProbeDue = (state: OllamaUpstreamState, now: number): boolean => {
  const account = state.account;
  return account === null || now - account.fetchedAt >= OLLAMA_ACCOUNT_PROBE_MIN_INTERVAL_MS;
};

// Fire-and-forget, armed by the same data-plane calls that arm the usage probe
// and behind its own interval. A failure is logged and dropped: unlike a usage
// window, a plan the dashboard could not read costs the row a name and nothing
// else, so it earns no slot of its own on the record.
export const scheduleOllamaAccountProbe = (
  upstreamId: string,
  config: OllamaUpstreamConfig,
  state: OllamaUpstreamState,
  fetcher: Fetcher,
  waitUntil: (promise: Promise<unknown>) => void,
): void => {
  if (!isOllamaCloudConfig(config)) return;
  if (!isOllamaAccountProbeDue(state, Date.now())) return;
  waitUntil(refreshOllamaAccount(upstreamId, config, fetcher).catch((error: unknown) => {
    console.warn(`Failed to refresh Ollama account for ${upstreamId}:`, error);
  }));
};
