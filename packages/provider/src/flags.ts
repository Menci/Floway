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
//
// Defaults are NOT declared in this catalog. Each provider owns the
// decision of which flags default on for its own upstream (and, when
// per-model differentiation matters, per model). Vendor-specific
// knowledge lives inside the provider package that talks to that
// vendor — the central catalog only describes identity, label, and
// UI copy. See `ProviderModule.defaultFlags` in `provider.ts` for the
// module surface, and each provider package's `defaults.ts` for the
// per-kind constants themselves. Per-model deltas — where the same
// provider forms a different opinion for individual models — are
// provider-internal: `createXxxProvider` computes them once and
// stakes the result into `ProviderModel.enabledFlags`.

export interface Flag {
  id: string;
  label: string;
  description: string;
}

export const OPTIONAL_FLAGS = [
  {
    id: 'vendor-deepseek',
    label: 'Vendor: DeepSeek',
    description: "Pick this when the upstream serves DeepSeek's chat completions API. The gateway translates between OpenAI canonical and DeepSeek's dialect: assistant reasoning rides on `reasoning_content` instead of `reasoning_text`; disabling reasoning uses a top-level `thinking: { type: 'disabled' }` instead of `reasoning_effort: 'none'`; cache hit/miss tokens normalise to OpenAI's `prompt_tokens_details.cached_tokens`; and structured-output `json_schema` requests are downgraded to `json_object` because DeepSeek doesn't accept schemas.",
  },
  {
    id: 'vendor-qwen',
    label: 'Vendor: Qwen',
    description: "Pick this when the upstream serves Qwen's (Alibaba Model Studio) chat completions API. The gateway rewrites a 'no reasoning' request to Qwen's top-level `enable_thinking: false` field instead of `reasoning_effort`.",
  },
  {
    id: 'vendor-kimi',
    label: 'Vendor: Kimi',
    description: "Pick this when the upstream serves Kimi's (Moonshot) chat completions API. The gateway normalises Kimi's flat `cached_tokens` usage field back to OpenAI's `prompt_tokens_details.cached_tokens`.",
  },
  {
    id: 'retry-cyber-policy',
    label: 'Retry on upstream cyber-policy block',
    description: 'Retry cyber_policy 4xx errors from the upstream (up to 10 attempts).',
  },
  {
    id: 'messages-web-search-shim',
    label: 'Messages web search shim',
    description: "Execute Anthropic native Messages web search through the gateway's configured search provider instead of forwarding it to the upstream. (When a client Messages request is routed to a non-Messages backend, the shim always runs regardless of this flag, because those targets cannot carry Anthropic server tools.)",
  },
  {
    id: 'responses-web-search-shim',
    label: 'Responses web search shim',
    description: "Execute the Responses `web_search` hosted tool through the gateway's configured search provider instead of forwarding it to a Responses upstream. (When a Responses request is routed to a non-Responses backend, the shim always runs regardless of this flag, because those targets cannot carry hosted web_search.)",
  },
  {
    id: 'responses-image-generation-shim',
    label: 'Responses image generation shim',
    description: "Execute the Responses `image_generation` hosted tool through the gateway's image-capable upstream (gpt-image-*) instead of forwarding it to a Responses upstream. The orchestrator model calls a generated function tool; the shim drives the standalone /images/{generations,edits} backend and synthesizes the native image_generation_call lifecycle. (When a Responses request is routed to a non-Responses backend, the shim always runs regardless of this flag, because those targets cannot carry the hosted image_generation tool.)",
  },
  {
    id: 'responses-compact-shim',
    label: 'Responses compact shim',
    description: "Simulate `response.compaction` against upstreams that don't expose a native compact wire. The shim swaps a compact request's instructions for the Codex SUMMARIZATION_PROMPT, runs a normal generate turn, and packs the upstream's summary back into a synthetic compaction envelope.",
  },
  {
    id: 'disable-reasoning-on-forced-tool-choice',
    label: 'Disable reasoning when caller forces a tool',
    description: "Disable reasoning in the outbound request when the caller forces a specific tool. Emits the gateway's canonical 'no reasoning' sentinel; the active Vendor flag (if any) translates that into the vendor's wire form.",
  },
  {
    id: 'demote-interleaved-system-to-user',
    label: 'Demote interleaved system messages to user',
    description: "Pick this when the upstream rejects `role: 'system'` after the first non-system message (e.g. DeepSeek-R1). The leading contiguous run of system messages is preserved; any later inline system message has its role rewritten to `user`, with content kept verbatim. For Anthropic Messages — where `payload.system` is conceptually the only first-position system slot — every inline `role: 'system'` message is demoted unconditionally.",
  },
  {
    id: 'demote-developer-to-system',
    label: 'Demote developer role to system',
    description: "Rewrite messages with role 'developer' to role 'system' for upstreams that do not recognise the developer role.",
  },
  {
    id: 'promote-system-to-developer',
    label: 'Promote system role to developer',
    description: "Rewrite message inputs with role 'system' to role 'developer' for upstreams that reject system-role input while accepting the developer role.",
  },
  {
    id: 'strip-billing-attribution',
    label: 'Strip Claude Code billing attribution from system prompt',
    description: "Remove `x-anthropic-billing-header:` lines from the request's system prompt before forwarding upstream. The block is irrelevant to non-Anthropic upstreams and only pollutes their prompt-cache key. On `claude-code`, the same block is the input Anthropic uses to bill the request against the user's plan and must be preserved.",
  },
  {
    id: 'strip-prompt-cache-key',
    label: 'Strip prompt_cache_key from request',
    description: 'Drop the top-level `prompt_cache_key` field from Chat Completions and Responses requests before forwarding upstream. Pick this when the upstream rejects `prompt_cache_key` as an unknown argument (e.g. Azure DeepSeek). OpenAI-native and truly OpenAI-compatible upstreams accept the field for prefix-cache attribution, so this stays off by default.',
  },
] as const satisfies readonly Flag[];

export type FlagId = (typeof OPTIONAL_FLAGS)[number]['id'];

const KNOWN_IDS = new Set<string>(OPTIONAL_FLAGS.map(f => f.id));

export const isKnownFlagId = (id: string): id is FlagId => KNOWN_IDS.has(id);

// A provider's full opinion on every flag: `true` = default on for this
// upstream, `false` = default off. The Record shape enforces exhaustiveness
// at compile time — adding a new flag to the catalog is a type error until
// every provider decides its default.
export type FlagDefaults = Readonly<Record<FlagId, boolean>>;

// Tri-state override or partial-default layer. Absent key = inherit from the
// previous layer. `true` = force-on at this layer. `false` = force-off at
// this layer (including flags seeded by earlier layers — the operator or
// per-model default explicitly opted out).
//
// Used by operator override storage (upstream-level
// `UpstreamRecord.flagOverrides`, per-model
// `UpstreamModelConfig.flagOverrides`) and by the per-model default
// deltas a provider computes inside its `create` — see
// `defaultFlagsForCopilotModel`.
export type FlagOverrides = Partial<Record<FlagId, boolean>>;

// Shape validator + canonicalizer shared by every entry point that
// takes a "flag id → boolean" map from an untrusted source
// (wire-form `parseFlagOverridesWire`, per-model
// `flagOverridesField`). Rejects non-object payloads, non-boolean
// values, and unknown flag ids; returns a copy with keys sorted
// lexicographically so equal maps round-trip to identical JSON.
// `msg` lets each caller keep its canonical operator-facing wording.
export const validateFlagOverridesRecord = (
  value: unknown,
  msg: {
    readonly notObject: string;
    readonly notBoolean: (id: string) => string;
    readonly unknownIds: (ids: readonly string[]) => string;
  },
): FlagOverrides => {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error(msg.notObject);
  }
  const result: Record<string, boolean> = {};
  const unknown: string[] = [];
  for (const [id, on] of Object.entries(value as Record<string, unknown>)) {
    if (typeof on !== 'boolean') throw new Error(msg.notBoolean(id));
    if (!isKnownFlagId(id)) {
      unknown.push(id);
      continue;
    }
    result[id] = on;
  }
  if (unknown.length > 0) throw new Error(msg.unknownIds(unknown));
  const sorted: FlagOverrides = {};
  for (const id of Object.keys(result).sort() as FlagId[]) sorted[id] = result[id];
  return sorted;
};

export const parseFlagOverridesWire = (value: unknown): FlagOverrides =>
  validateFlagOverridesRecord(value, {
    notObject: 'flag_overrides must be an object of { flagId: boolean }',
    notBoolean: id => `flag_overrides.${id} must be a boolean`,
    unknownIds: ids => `Unknown flag_overrides ids: ${ids.join(', ')}`,
  });

// Reduce ordered flag layers to the effective enabled set. Layers apply
// left-to-right; a later layer's explicit `true` re-enables a previously-off
// flag, an explicit `false` overrides any earlier `true`, and an absent key
// inherits the previous layer's decision. `undefined` layers are skipped.
//
// Canonical layer order across every provider:
//   1. Provider upstream default (per-kind constant)
//   2. Operator upstream override (`UpstreamRecord.flagOverrides`)
//   3. Per-model layer — provider's per-model default for auto rows
//      (`defaultFlagsForCopilotModel(model)`), operator's per-model
//      override for manual rows (`UpstreamModelConfig.flagOverrides`).
//      Never both, since an auto/manual row cannot be the other.
//
// Placing per-model last lets provider-declared technical necessities
// (e.g. Copilot forcing demote-interleaved-system-to-user on for
// Claude < 4.8, whose Vertex backend rejects inline `role:'system'`)
// survive an upstream-wide operator override. Operators who genuinely
// want to opt out of a provider's per-model call switch the row to
// Manual and override there — explicit and visible in the dashboard.
// The function itself doesn't enforce this order; each provider's
// `createXxx` composes its layer list in this shape.
export const resolveEffectiveFlags = (
  layers: readonly (FlagOverrides | undefined)[],
): ReadonlySet<FlagId> => {
  const effective = new Set<FlagId>();
  for (const layer of layers) {
    if (!layer) continue;
    for (const [id, on] of Object.entries(layer) as [FlagId, boolean][]) {
      if (on) effective.add(id);
      else effective.delete(id);
    }
  }
  return effective;
};
