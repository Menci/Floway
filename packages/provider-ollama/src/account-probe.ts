// Ollama Cloud account probe.
//
// ollama.com serves `POST /api/me` behind the same API key the data plane
// already uses (405 to GET), and answers with the account behind that key:
//
//   {"ID": "...", "CreatedAt": "...", "Email": "...", "Name": "...", "Bio": "",
//    "AvatarURL": "...", "FirstName": "", "LastName": "", "Links": [],
//    "Plan": "free"}
//
// The keys are capitalized, which is what a Go struct marshals to when it
// declares no json tags — and the live body carries `CreatedAt` and `Links`,
// which the client's own `UserResponse` does not declare at all. So the hosted
// service serializes a wider, untagged type than the client type describes, and
// reading the tag names off that type gives `plan`, a key this endpoint never
// sends. Verified against a live account on 2026-08-09: the body's keys are
// exactly the ten above, `plan` is absent, `Plan` is "free".
// https://github.com/ollama/ollama/blob/f0078ae4766d0d570e196158f20dde309bd96124/api/types.go#L939-L949
//
// Only the plan and the two identity fields the dashboard names the account by
// are kept. The avatar is deliberately dropped: rendering it would have the
// operator's browser fetch an image from ollama.com on every dashboard visit,
// and the Copilot card next to this one names its account without one.

import type { OllamaConnectionConfig } from './config.ts';
import { ollamaFetchMe } from './fetch.ts';
import { type OllamaAccountEntry, type OllamaUpstreamState, readOllamaUpstreamState } from './state.ts';
import { type Fetcher, getProviderRepo } from '@floway-dev/provider';

// A subscription changes on a billing boundary at most, so this refreshes on a
// wholly different cadence from the usage windows beside it: an upstream
// serving traffic re-reads its account once a day.
export const OLLAMA_ACCOUNT_PROBE_MIN_INTERVAL_MS = 24 * 60 * 60 * 1000;

const optionalString = (value: unknown): string | null =>
  typeof value === 'string' && value !== '' ? value : null;

export const fetchOllamaAccount = async (
  config: OllamaConnectionConfig,
  fetcher: Fetcher,
): Promise<OllamaAccountEntry> => {
  const response = await ollamaFetchMe(
    config,
    { method: 'POST', headers: new Headers({ accept: 'application/json' }), body: '{}' },
    fetcher,
  );
  const rawText = await response.text();
  if (!response.ok) {
    throw new Error(`Ollama /api/me returned ${response.status}: ${rawText.trim().slice(0, 256)}`);
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(rawText);
  } catch (cause) {
    throw new Error(`Ollama /api/me returned a non-JSON body (${response.status})`, { cause });
  }
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    throw new Error(`Ollama /api/me returned a non-object body (${response.status})`);
  }
  const body = parsed as Record<string, unknown>;
  return {
    fetchedAt: Date.now(),
    plan: optionalString(body.Plan),
    name: optionalString(body.Name),
    email: optionalString(body.Email),
  };
};

const persistAccountEntry = async (upstreamId: string, entry: OllamaAccountEntry): Promise<void> => {
  await getProviderRepo().upstreams.saveState(upstreamId, current => {
    const state = readOllamaUpstreamState(current);
    // Races resolve by read time rather than by write order, as the usage slot
    // beside this one does, and equal stamps mean equally fresh rather than a
    // rollback.
    if (state.account && state.account.fetchedAt > entry.fetchedAt) return current;
    return { ...state, account: entry } satisfies OllamaUpstreamState;
  });
};

export const refreshOllamaAccount = async (
  upstreamId: string,
  config: OllamaConnectionConfig,
  fetcher: Fetcher,
): Promise<OllamaAccountEntry> => {
  const entry = await fetchOllamaAccount(config, fetcher);
  await persistAccountEntry(upstreamId, entry);
  return entry;
};

export const isOllamaAccountProbeDue = (state: OllamaUpstreamState, now: number): boolean => {
  const account = state.account;
  return account === null || now - account.fetchedAt >= OLLAMA_ACCOUNT_PROBE_MIN_INTERVAL_MS;
};
