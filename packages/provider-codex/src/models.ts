import {
  CODEX_BACKEND_BASE,
  CODEX_CLI_VERSION,
  CODEX_MODELS_PATH,
  CODEX_ORIGINATOR,
  CODEX_USER_AGENT,
} from './constants.ts';
import { pricingForCodexModelKey } from './pricing.ts';
import { type Fetcher, type ProviderModel, type UpstreamChatModelConfig } from '@floway-dev/provider';

export interface CodexRawModel {
  id: string;
  display_name: string;
  // Per-request context window. Upstream also returns a sibling
  // `max_context_window` field as the upper bound for config overrides
  // (https://github.com/openai/codex/blob/d66708232299bdbf373ec55b0d6b938c246cfa60/codex-rs/protocol/src/openai_models.rs#L383-L386);
  // Floway has no override path, so only the operational value is kept.
  context_window: number;
  input_modalities?: readonly ('text' | 'image')[];
  reasoning_efforts?: readonly string[];
  default_reasoning_effort?: string;
}

// `fetcher` is required so the catalog refresh traverses the same proxy/
// dial chain configured for request-time traffic.
export const fetchCodexCatalog = async (opts: { accessToken: string; accountId: string; signal?: AbortSignal; fetcher: Fetcher }): Promise<CodexRawModel[]> => {
  const response = await opts.fetcher(`${CODEX_BACKEND_BASE}${CODEX_MODELS_PATH}?client_version=${CODEX_CLI_VERSION}`, {
    method: 'GET',
    headers: {
      authorization: `Bearer ${opts.accessToken}`,
      'chatgpt-account-id': opts.accountId,
      originator: CODEX_ORIGINATOR,
      'user-agent': CODEX_USER_AGENT,
      accept: 'application/json',
    },
    signal: opts.signal,
  });
  if (!response.ok) {
    const body = await response.text();
    throw new Error(`Codex /models fetch failed: ${response.status} ${body.slice(0, 200)}`);
  }
  const parsed = await response.json() as { models?: unknown };
  if (!Array.isArray(parsed.models)) throw new Error('Codex /models response missing models array');
  return parsed.models.map(assertRawModel);
};

const isPlainRecord = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null;

// Fail loud on malformed upstream catalog responses: a missing field
// signals an upstream contract change we need to notice. New optional
// fields (`input_modalities`, `supported_reasoning_levels`,
// `default_reasoning_level`) are tolerated when absent for backwards
// compatibility with older catalog snapshots, but throw on type drift.
const assertRawModel = (value: unknown): CodexRawModel => {
  if (!isPlainRecord(value)) throw new TypeError('Codex model entry is not an object');
  const slug = value.slug;
  if (typeof slug !== 'string') throw new TypeError('Codex model entry missing slug');
  const display_name = value.display_name;
  if (typeof display_name !== 'string') throw new TypeError(`Codex model entry ${slug} missing display_name`);
  const context_window = value.context_window;
  if (typeof context_window !== 'number') throw new TypeError(`Codex model entry ${slug} missing context_window`);

  const raw: CodexRawModel = { id: slug, display_name, context_window };

  if (value.input_modalities !== undefined) {
    if (!Array.isArray(value.input_modalities)) throw new TypeError(`Codex model entry ${slug} input_modalities not an array`);
    const out: ('text' | 'image')[] = [];
    for (const m of value.input_modalities) {
      if (m !== 'text' && m !== 'image') throw new TypeError(`Codex model entry ${slug} unknown modality ${JSON.stringify(m)}`);
      if (!out.includes(m)) out.push(m);
    }
    raw.input_modalities = out;
  }

  if (value.supported_reasoning_levels !== undefined) {
    if (!Array.isArray(value.supported_reasoning_levels)) throw new TypeError(`Codex model entry ${slug} supported_reasoning_levels not an array`);
    const efforts: string[] = [];
    for (const entry of value.supported_reasoning_levels) {
      if (!isPlainRecord(entry) || typeof entry.effort !== 'string' || entry.effort.length === 0) {
        throw new TypeError(`Codex model entry ${slug} reasoning level entry malformed`);
      }
      if (!efforts.includes(entry.effort)) efforts.push(entry.effort);
    }
    raw.reasoning_efforts = efforts;
  }

  if (value.default_reasoning_level !== undefined) {
    if (typeof value.default_reasoning_level !== 'string' || value.default_reasoning_level.length === 0) {
      throw new TypeError(`Codex model entry ${slug} default_reasoning_level malformed`);
    }
    raw.default_reasoning_effort = value.default_reasoning_level;
  }

  return raw;
};

// Codex exposes only the Responses endpoint. Pricing is looked up from the
// per-slug table in pricing.ts so the dashboard can report a notional
// API-rate cost even though Codex itself bills as a flat-fee subscription.
//
// `enabledFlags` is the upstream-resolved flag set (provider defaults
// merged with the row's `flagOverrides`); it propagates per-model so
// downstream interceptors can read the effective set without re-resolving.
export const codexRawToProviderModel = (raw: CodexRawModel, enabledFlags: ReadonlySet<string>): ProviderModel => {
  const cost = pricingForCodexModelKey(raw.id);
  const chat: UpstreamChatModelConfig = {};
  if (raw.input_modalities && raw.input_modalities.length > 0) {
    chat.modalities = { input: raw.input_modalities, output: ['text'] };
  }
  if (raw.reasoning_efforts && raw.reasoning_efforts.length > 0) {
    let effortDefault: string;
    if (raw.default_reasoning_effort !== undefined) {
      if (!raw.reasoning_efforts.includes(raw.default_reasoning_effort)) {
        throw new Error(`Codex model ${raw.id}: default_reasoning_level not in supported_reasoning_levels`);
      }
      effortDefault = raw.default_reasoning_effort;
    } else {
      effortDefault = raw.reasoning_efforts.includes('medium') ? 'medium' : raw.reasoning_efforts[0]!;
    }
    chat.reasoning = { effort: { supported: raw.reasoning_efforts, default: effortDefault } };
  }
  return {
    id: raw.id,
    display_name: raw.display_name,
    owned_by: 'openai',
    kind: 'chat',
    limits: {
      max_context_window_tokens: raw.context_window,
    },
    endpoints: { responses: {} },
    enabledFlags,
    ...(cost ? { cost } : {}),
    ...(Object.keys(chat).length > 0 ? { chat } : {}),
  };
};
