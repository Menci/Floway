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

import { fetchOllamaApi } from './api.ts';
import type { OllamaUpstreamConfig } from './config.ts';
import { type OllamaAccountEntry, type OllamaUpstreamState, readOllamaUpstreamState } from './state.ts';
import { readHttpResponseText } from '@floway-dev/http';
import type { Result } from '@floway-dev/pipeline';
import { type ProviderRepo, getProviderRepo, type ProviderServices } from '@floway-dev/provider';

// A subscription changes on a billing boundary at most, so this refreshes on a
// wholly different cadence from the usage windows beside it: an upstream
// serving traffic re-reads its account once a day.
export const OLLAMA_ACCOUNT_PROBE_MIN_INTERVAL_MS = 24 * 60 * 60 * 1000;

const optionalString = (value: unknown): string | null =>
  typeof value === 'string' && value !== '' ? value : null;

export const fetchOllamaAccount = async (
  config: OllamaUpstreamConfig,
  fetcher: ReturnType<ProviderServices['fetcher']>,
): Promise<Result<OllamaAccountEntry, unknown>> => {
  const result = await fetchOllamaApi(
    config,
    '/api/me',
    { method: 'POST', headers: new Headers({ accept: 'application/json' }), body: '{}' },
    fetcher,
  );
  if (!result.ok) return { ok: false, error: result.error.cause };
  const response = result.value;
  const rawText = await readHttpResponseText(response);
  if (!rawText.ok) return { ok: false, error: rawText.error.cause };
  if (!response.ok) {
    return { ok: false, error: new Error(`Ollama /api/me returned ${response.status}: ${rawText.value.trim().slice(0, 256)}`) };
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(rawText.value);
  } catch (cause) {
    if (!(cause instanceof SyntaxError)) throw cause;
    return { ok: false, error: new Error(`Ollama /api/me returned a non-JSON body (${response.status})`, { cause }) };
  }
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    return { ok: false, error: new Error(`Ollama /api/me returned a non-object body (${response.status})`) };
  }
  const body = parsed as Record<string, unknown>;
  return {
    ok: true, value: {
      fetchedAt: Date.now(),
      plan: optionalString(body.Plan),
      name: optionalString(body.Name),
      email: optionalString(body.Email),
    },
  };
};

const persistAccountEntry = async (repo: ProviderRepo, upstreamId: string, entry: OllamaAccountEntry, expectedConfigVersion?: number): Promise<Result<void, unknown>> => {
  try {
    await repo.upstreams.saveState(upstreamId, (current, configVersion) => {
      if (expectedConfigVersion !== undefined && configVersion !== expectedConfigVersion) return current;
      const state = readOllamaUpstreamState(current);
      // Older observations cannot overwrite a more recent read.
      if (state.account && state.account.fetchedAt > entry.fetchedAt) return current;
      return { ...state, account: entry } satisfies OllamaUpstreamState;
    });
  } catch (error) {
    return { ok: false, error };
  }
  return { ok: true, value: undefined };
};

export const refreshOllamaAccount = async (
  upstreamId: string,
  config: OllamaUpstreamConfig,
  fetcher: ReturnType<ProviderServices['fetcher']>,
  repo = getProviderRepo(),
  expectedConfigVersion?: number,
): Promise<Result<OllamaAccountEntry, unknown>> => {
  const entry = await fetchOllamaAccount(config, fetcher);
  if (!entry.ok) return entry;
  const persisted = await persistAccountEntry(repo, upstreamId, entry.value, expectedConfigVersion);
  return persisted.ok ? entry : persisted;
};

export const isOllamaAccountProbeDue = (state: OllamaUpstreamState, now: number): boolean => {
  const account = state.account;
  return account === null || now - account.fetchedAt >= OLLAMA_ACCOUNT_PROBE_MIN_INTERVAL_MS;
};
