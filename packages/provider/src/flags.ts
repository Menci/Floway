// Stable identities for every admin-toggleable per-upstream behavior flag.
// Interceptor code references a flag by id; the dependency goes interceptor
// → flag, never the other way. The dashboard owns presentation and translated
// copy, while this package owns the ids shared by providers and persisted
// overrides.
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
// knowledge lives inside the provider package that talks to that vendor. See
// `ProviderModule.defaultFlags` in `provider.ts` for the module surface, and
// each provider package's `defaults.ts` for the per-kind constants themselves.
// Per-model deltas are provider-internal: `createXxxProvider` computes them
// once and stakes the result into `ProviderModel.enabledFlags`.

export const OPTIONAL_FLAG_IDS = [
  'vendor-deepseek',
  'vendor-qwen',
  'vendor-kimi',
  'messages-web-search-shim',
  'responses-web-search-shim',
  'responses-image-generation-shim',
  'responses-compact-shim',
  'disable-reasoning-on-forced-tool-choice',
  'rewrite-mid-conv-system-to-user',
  'rewrite-developer-to-system',
  'rewrite-system-to-developer',
  'strip-billing-attribution',
  'strip-prompt-cache-key',
  'usage-exclusive-cached-tokens',
] as const;

export type FlagId = (typeof OPTIONAL_FLAG_IDS)[number];

const KNOWN_IDS = new Set<string>(OPTIONAL_FLAG_IDS);

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
//   3. Per-model layer — the provider's per-model default
//      (`defaultFlagsForCopilotModel(model)`) for an auto row, the operator's
//      `UpstreamModelConfig.flagOverrides` for a manual row; the two row
//      kinds are defined on `UpstreamModelConfig` in `model-config.ts`.
//      Never both, since an auto/manual row cannot be the other.
//
// Placing per-model last lets provider-declared technical necessities
// (e.g. Copilot forcing rewrite-mid-conv-system-to-user on for
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
