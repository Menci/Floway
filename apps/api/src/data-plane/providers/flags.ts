// Flag catalog. Single source of truth for every admin-toggleable
// per-upstream behavior flag exposed by the dashboard, validated by the
// /api/upstreams endpoint, and stored in upstreams.flag_overrides.
//
// The catalog only describes flags. Source/target interceptor code
// references a flag by id; the dependency goes interceptor → flag, never
// the other way. This makes "one flag drives multiple interceptors" trivial
// and keeps the catalog free of runtime closures.
//
// Vendor-style flags (`vendor-deepseek`, `vendor-qwen`, `vendor-kimi`) each
// own a dedicated last-running interceptor under
// `apps/api/src/data-plane/llm/targets/<api>/interceptors/vendor-<vendor>-normalize.ts`.
// That interceptor translates the gateway's OpenAI-canonical request and
// response shape into the vendor's wire dialect. With no vendor flag set,
// behavior defaults to the OpenAI standard and no vendor rewrite runs.
// Vendor flags are mutually exclusive per binding — the dashboard surfaces
// them as a single radio rather than three independent toggles.

import type { UpstreamProviderKind } from '../../repo/types.ts';

export interface Flag {
  id: string;
  label: string;
  description: string;
  // Provider kinds that turn this flag on by default. The dashboard uses this
  // to render the "Inherit" radio as "Inherit: on" or "Inherit: off". Provider
  // construction reads `defaultsForProvider(kind)` to seed the resolver.
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
  {
    id: 'messages-web-search-shim',
    label: 'Messages web search shim',
    description: "Execute Anthropic native Messages web search through the gateway's configured search provider instead of forwarding it to the upstream. (When a client Messages request is routed to a non-Messages backend, the shim always runs regardless of this flag, because those targets cannot carry Anthropic server tools.)",
    defaultFor: ['copilot', 'azure'],
  },
  {
    id: 'responses-web-search-shim',
    label: 'Responses web search shim',
    description: "Execute the Responses `web_search` hosted tool through the gateway's configured search provider instead of forwarding it to a Responses upstream. (When a Responses request is routed to a non-Responses backend, the shim always runs regardless of this flag, because those targets cannot carry hosted web_search.)",
    defaultFor: [],
  },
  {
    id: 'disable-reasoning-on-forced-tool-choice',
    label: 'Disable reasoning when caller forces a tool',
    description: "Disable reasoning in the outbound request when the caller forces a specific tool. Emits the gateway's canonical 'no reasoning' sentinel; the active Vendor flag (if any) translates that into the vendor's wire form.",
    defaultFor: [],
  },
] as const satisfies readonly Flag[];

export type OptionalFlagId = (typeof OPTIONAL_FLAGS)[number]['id'];

const KNOWN_IDS = new Set<string>(OPTIONAL_FLAGS.map(f => f.id));

export const getFlagCatalog = (): readonly Flag[] => OPTIONAL_FLAGS;

export const isKnownFlagId = (id: string): id is OptionalFlagId => KNOWN_IDS.has(id);

// Provider-default flag set. Computed from the catalog's `defaultFor` field
// so the dashboard and the runtime resolver share one source of truth.
//
// Memoized: Azure's per-deployment `getProvidedModels` loop calls this once
// per deployment per request to seed the effective-flag resolver. The catalog
// is module-constant, so cache the frozen result set per provider kind.
const DEFAULTS_CACHE = new Map<UpstreamProviderKind, ReadonlySet<string>>();
export const defaultsForProvider = (kind: UpstreamProviderKind): ReadonlySet<string> => {
  let cached = DEFAULTS_CACHE.get(kind);
  if (!cached) {
    cached = new Set(OPTIONAL_FLAGS.filter(f => (f.defaultFor as readonly string[]).includes(kind)).map(f => f.id));
    DEFAULTS_CACHE.set(kind, cached);
  }
  return cached;
};

// Wire-form validator shared by every control-plane entrypoint that accepts
// flag_overrides JSON (upstream CRUD, import). Throws on any malformed
// shape, returns a sorted, validated Record<OptionalFlagId, boolean>.
// Callers that need ValidationResult semantics wrap this in try/catch.
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
