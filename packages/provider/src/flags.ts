// Flag catalog. Single source of truth for every admin-toggleable
// per-upstream behavior flag.
//
// The catalog only describes flags. Interceptor code references a flag by
// id; the dependency goes interceptor → flag, never the other way. This
// makes "one flag drives multiple interceptors" trivial and keeps the
// catalog free of runtime closures.
//
// Vendor-style flags (`vendor-deepseek`, `vendor-qwen`, `vendor-kimi`) are
// mutually exclusive per model: a vendor interceptor translates the
// gateway's OpenAI-canonical request and response shape into the vendor's
// wire dialect; with no vendor flag set, behavior defaults to the OpenAI
// standard and no vendor rewrite runs.

import type { UpstreamProviderKind } from './model.ts';
import { ALL_PROVIDER_KINDS } from './model.ts';

export interface Flag {
  id: string;
  label: string;
  description: string;
  // Provider kinds that turn this flag on by default.
  defaultFor: readonly UpstreamProviderKind[];
}

export const OPTIONAL_FLAGS = [
  {
    id: 'vendor-deepseek',
    label: 'Vendor: DeepSeek',
    description: "Pick this when the upstream serves DeepSeek's chat completions API. The gateway translates between OpenAI canonical and DeepSeek's dialect: assistant reasoning rides on `reasoning_content` instead of `reasoning_text`; disabling reasoning uses a top-level `thinking: { type: 'disabled' }` instead of `reasoning_effort: 'none'`; cache hit/miss tokens normalise to OpenAI's `prompt_tokens_details.cached_tokens`; and structured-output `json_schema` requests are downgraded to `json_object` because DeepSeek doesn't accept schemas.",
    defaultFor: [],
  },
  {
    id: 'vendor-qwen',
    label: 'Vendor: Qwen',
    description: "Pick this when the upstream serves Qwen's (Alibaba Model Studio) chat completions API. The gateway rewrites a 'no reasoning' request to Qwen's top-level `enable_thinking: false` field instead of `reasoning_effort`.",
    defaultFor: [],
  },
  {
    id: 'vendor-kimi',
    label: 'Vendor: Kimi',
    description: "Pick this when the upstream serves Kimi's (Moonshot) chat completions API. The gateway normalises Kimi's flat `cached_tokens` usage field back to OpenAI's `prompt_tokens_details.cached_tokens`.",
    defaultFor: [],
  },
  {
    id: 'retry-cyber-policy',
    label: 'Retry on upstream cyber-policy block',
    description: 'Retry cyber_policy 4xx errors from the upstream (up to 10 attempts).',
    defaultFor: ['copilot'],
  },
  // The three shim flags default on for every upstream kind that runs
  // operator-shaped traffic through translation. They are off by default on
  // `codex` (no hosted tools at all) and on `claude-code` (the shaped-
  // passthrough path forwards caller bytes verbatim, so a gateway-side shim
  // would silently rewrite a request the operator deliberately let through
  // unchanged).
  {
    id: 'messages-web-search-shim',
    label: 'Messages web search shim',
    description: "Execute Anthropic native Messages web search through the gateway's configured search provider instead of forwarding it to the upstream. (When a client Messages request is routed to a non-Messages backend, the shim always runs regardless of this flag, because those targets cannot carry Anthropic server tools.)",
    defaultFor: ALL_PROVIDER_KINDS.filter(p => !['codex', 'claude-code'].includes(p)),
  },
  {
    id: 'responses-web-search-shim',
    label: 'Responses web search shim',
    description: "Execute the Responses `web_search` hosted tool through the gateway's configured search provider instead of forwarding it to a Responses upstream. (When a Responses request is routed to a non-Responses backend, the shim always runs regardless of this flag, because those targets cannot carry hosted web_search.)",
    defaultFor: ALL_PROVIDER_KINDS.filter(p => !['codex', 'claude-code'].includes(p)),
  },
  {
    id: 'responses-image-generation-shim',
    label: 'Responses image generation shim',
    description: "Execute the Responses `image_generation` hosted tool through the gateway's image-capable upstream (gpt-image-*) instead of forwarding it to a Responses upstream. The orchestrator model calls a generated function tool; the shim drives the standalone /images/{generations,edits} backend and synthesizes the native image_generation_call lifecycle. (When a Responses request is routed to a non-Responses backend, the shim always runs regardless of this flag, because those targets cannot carry the hosted image_generation tool.)",
    defaultFor: ALL_PROVIDER_KINDS.filter(p => !['codex', 'claude-code'].includes(p)),
  },
  {
    id: 'responses-compact-shim',
    label: 'Responses compact shim',
    description: "Simulate `response.compaction` against upstreams that don't expose a native compact wire. The shim swaps a compact request's instructions for the Codex SUMMARIZATION_PROMPT, runs a normal generate turn, and packs the upstream's summary back into a synthetic compaction envelope. Default on for `claude-code` and `ollama` (no native compaction); default off for `codex`, `copilot`, `azure`, `custom` (each has a native compact wire).",
    defaultFor: ['claude-code', 'ollama'],
  },
  {
    id: 'disable-reasoning-on-forced-tool-choice',
    label: 'Disable reasoning when caller forces a tool',
    description: "Disable reasoning in the outbound request when the caller forces a specific tool. Emits the gateway's canonical 'no reasoning' sentinel; the active Vendor flag (if any) translates that into the vendor's wire form.",
    defaultFor: [],
  },
  {
    id: 'demote-interleaved-system-to-user',
    label: 'Demote interleaved system messages to user',
    description: "Pick this when the upstream rejects `role: 'system'` after the first non-system message (e.g. DeepSeek-R1). The leading contiguous run of system messages is preserved; any later inline system message has its role rewritten to `user`, with content kept verbatim. For Anthropic Messages — where `payload.system` is conceptually the only first-position system slot — every inline `role: 'system'` message is demoted unconditionally.",
    defaultFor: [],
  },
  {
    id: 'demote-developer-to-system',
    label: 'Demote developer role to system',
    description: "Rewrite messages with role 'developer' to role 'system' for upstreams that do not recognise the developer role.",
    defaultFor: [],
  },
  // The `x-anthropic-billing-header:` line the Claude Code CLI injects is a
  // literal `cch=00000;` placeholder, not a per-request hash — Anthropic's
  // subscription endpoint reads the placeholder block itself to attribute
  // billing. So strip it on every non-Anthropic upstream (it would only
  // pollute their prompt-cache key) and keep it only on `claude-code`,
  // where the same block is what bills the request against the user's plan.
  {
    id: 'strip-billing-attribution',
    label: 'Strip Claude Code billing attribution from system prompt',
    description: "Remove `x-anthropic-billing-header:` lines from the request's system prompt before forwarding upstream. Default on for every upstream kind except `claude-code` — the block is irrelevant to non-Anthropic upstreams and only pollutes their prompt-cache key. Default off for `claude-code`, where the same block is the input Anthropic uses to bill the request against the user's plan.",
    defaultFor: ALL_PROVIDER_KINDS.filter(p => p !== 'claude-code'),
  },
] as const satisfies readonly Flag[];

export type OptionalFlagId = (typeof OPTIONAL_FLAGS)[number]['id'];

const KNOWN_IDS = new Set<string>(OPTIONAL_FLAGS.map(f => f.id));

export const getFlagCatalog = (): readonly Flag[] => OPTIONAL_FLAGS;

export const isKnownFlagId = (id: string): id is OptionalFlagId => KNOWN_IDS.has(id);

// Provider-default flag set. Computed from the catalog's `defaultFor` field.
//
// Memoized because the catalog is module-constant and providers may call
// this on a per-request hot path; cache the read-only result set per
// provider kind.
const DEFAULTS_CACHE = new Map<UpstreamProviderKind, ReadonlySet<string>>();
export const defaultsForProvider = (kind: UpstreamProviderKind): ReadonlySet<string> => {
  let cached = DEFAULTS_CACHE.get(kind);
  if (!cached) {
    cached = new Set(OPTIONAL_FLAGS.filter(f => (f.defaultFor as readonly string[]).includes(kind)).map(f => f.id));
    DEFAULTS_CACHE.set(kind, cached);
  }
  return cached;
};

// Validate a wire-form flag_overrides object. Throws on malformed shape;
// returns a sorted, validated record of known flag ids to booleans.
export const parseFlagOverridesWire = (value: unknown): Record<string, boolean> => {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error('flag_overrides must be an object of { flagId: boolean }');
  }
  const result: Record<string, boolean> = {};
  const unknown: string[] = [];
  for (const [id, on] of Object.entries(value as Record<string, unknown>)) {
    if (typeof on !== 'boolean') throw new Error(`flag_overrides.${id} must be a boolean`);
    if (!isKnownFlagId(id)) {
      unknown.push(id);
      continue;
    }
    result[id] = on;
  }
  if (unknown.length > 0) throw new Error(`Unknown flag_overrides ids: ${unknown.join(', ')}`);
  const sorted: Record<string, boolean> = {};
  for (const id of Object.keys(result).sort()) sorted[id] = result[id];
  return sorted;
};

// Tri-state override map. Absent key = inherit from the parent layer.
// `true` = force-on at this layer. `false` = force-off at this layer (including
// flags seeded by provider defaults — admins explicitly toggled Off to opt out).
export type FlagOverrides = Record<string, boolean>;

// Reduce a sequence of override layers atop the provider defaults to the
// effective enabled set. Layers are applied left-to-right; a later layer's
// explicit `true` re-enables a previously-off flag, and an explicit `false`
// overrides any earlier `true` (and any default seed). An `undefined` layer
// is skipped entirely.
export const resolveEffectiveFlags = (
  providerDefaults: ReadonlySet<string>,
  layers: readonly (FlagOverrides | undefined)[],
): ReadonlySet<string> => {
  const effective = new Set<string>(providerDefaults);
  for (const layer of layers) {
    if (!layer) continue;
    for (const [id, on] of Object.entries(layer)) {
      if (on) effective.add(id);
      else effective.delete(id);
    }
  }
  return effective;
};
