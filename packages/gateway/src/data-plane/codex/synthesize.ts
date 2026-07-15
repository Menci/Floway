// Build a Codex `models.json`-shaped catalog entry for a Floway chat model.
//
// Both branches of the pipeline — a bundled catalog match and a registry
// model with no bundled equivalent — funnel through this one function.
// `base` is the bundled entry when there is a match, `undefined` otherwise;
// on `undefined` the hardcoded `BASELINE` fills in the same slot.
//
// Field precedence, per field family:
//
//   1. `slug` — always the registry public id (bundled base carries the
//      upstream slug; we always overwrite with the operator-visible id).
//   2. `display_name` — `model.display_name ?? source.display_name`. Registry
//      wins when the operator set a label; else the bundled/base label
//      rides through. Bundled-inherit is fine here because display_name is
//      pure UI — inheriting the vendored "GPT-5.5" string when the operator
//      has not customized it is meaningful, unlike service_tiers below
//      where a stale bundled value could mis-bill a real request.
//   3. `service_tiers` — unconditional override with `deriveServiceTiers(model)`.
//      No fallback to bundled: bundled entries may advertise OpenAI 1p tiers
//      Floway cannot bill, so publishing them without registry-side unit
//      prices would surface a toggle we could not honor.
//   4. `context_window` / `max_context_window` — `registry ?? source ?? 128k`.
//      Registry-supplied limits win; else preserve the base's value (bundled
//      entries carry a real OpenAI-vendored window); else the conservative
//      default so codex's `(cw * 9) / 10` auto-compact math never sees zero.
//   5. `input_modalities` (and its derived siblings `supports_image_detail_original`
//      and `web_search_tool_type`) — `chat.modalities.input ?? source.input_modalities`.
//      When the operator declared `chat.modalities`, honour it (even if the
//      upstream base advertised more); else keep the base's list. The two
//      "does this model see images" derivations always follow the final
//      modality list so they cannot drift from it.
//   6. `supported_reasoning_levels` / `default_reasoning_level` — same
//      `chat.reasoning.effort ?? source's` precedence as the modalities.
//
// Fields not listed above ride through from `source` unchanged: the base
// pass supplies bundled defaults for bundled-hit and hardcoded baselines
// for the miss path.

import type { CatalogModel } from './catalog.ts';
import { synthesizedBaseInstructions } from './synthesized-base-instructions.ts';
import type { InternalModel, Modality } from '@floway-dev/provider';

// A synthesized (miss-path) entry with no registry-supplied
// `max_context_window_tokens` still needs SOME window — codex's auto-compact
// math (see `auto_compact_token_limit` in BASELINE for the source URL) blows
// up on absent / zero. 128k is deliberately low; an operator who wants more
// sets `max_context_window_tokens` on the registry entry.
const CONSERVATIVE_DEFAULT_CONTEXT_WINDOW = 128_000;

// Hardcoded baseline for a codex catalog entry when no bundled match exists.
// The synthesizer starts from this object (via a shallow spread) and layers
// registry-derived overlays on top. Bundled matches use the bundled entry
// as the base and overlay the same fields, so both paths converge on one
// field-precedence rule set (documented above).
const BASELINE: CatalogModel = {
  slug: '',                                             // always overwritten
  description: '',
  truncation_policy: { mode: 'tokens', limit: 10000 },
  input_modalities: ['text'],
  supports_image_detail_original: false,
  web_search_tool_type: 'text',
  supports_parallel_tool_calls: true,
  supported_reasoning_levels: [],
  shell_type: 'shell_command',
  support_verbosity: false,
  default_verbosity: null,
  prefer_websockets: true,
  supported_in_api: true,
  // ModelInfo requires `supports_reasoning_summaries: bool` and
  // `apply_patch_tool_type: Option<...>` to be present; absence aborts
  // deserialization of the whole `/models` body and codex silently falls
  // back to its bundled catalog
  // (https://github.com/openai/codex/blob/f66d793a2d78287c8c28a5f41f39c58ac49bcc25/codex-rs/protocol/src/openai_models.rs#L351-L429).
  supports_reasoning_summaries: false,
  apply_patch_tool_type: null,
  default_reasoning_summary: 'none',
  // Placeholder — the miss-path always overlays this with a model-specific
  // string from `synthesizedBaseInstructions(model.id, model.display_name ?? model.id)`.
  // Leaving an empty default here keeps BASELINE a plain constant that
  // TypeScript can type without depending on the eventual model.
  base_instructions: '',
  experimental_supported_tools: [],
  additional_speed_tiers: [],
  service_tiers: [],
  priority: 0,
  visibility: 'list',
  availability_nux: null,
  upgrade: null,
  // Bundled entries also emit `null` here, and codex's
  // `ModelInfo::auto_compact_token_limit()` resolves it to `(context_window
  // * 9) / 10`. An explicit positive integer would be clamped down by that
  // same 90% ceiling, so writing a value here is a no-op at best and a
  // ceiling lowering at worst
  // (https://github.com/openai/codex/blob/f66d793a2d78287c8c28a5f41f39c58ac49bcc25/codex-rs/protocol/src/openai_models.rs#L436-L447).
  auto_compact_token_limit: null,
  context_window: CONSERVATIVE_DEFAULT_CONTEXT_WINDOW,
  max_context_window: CONSERVATIVE_DEFAULT_CONTEXT_WINDOW,
};

// Registry-derived: every distinct serviceTier selector is a billable wire-id.
// Names mirror ids and descriptions are blank — Floway does not carry separate
// tier metadata, and Codex only needs the id to round-trip the selection.
const deriveServiceTiers = (model: InternalModel): { id: string; name: string; description: string }[] => {
  const ids = new Set(model.pricing?.entries.flatMap(entry => typeof entry.selector?.serviceTier === 'string' ? [entry.selector.serviceTier] : []) ?? []);
  return [...ids].map(id => ({ id, name: id, description: '' }));
};

export const synthesizeCatalogEntry = (model: InternalModel, base?: CatalogModel): CatalogModel => {
  const source = base ?? BASELINE;

  // Overlay chain for every registry-derived field: `registry ?? source ?? BASELINE`.
  // BASELINE is always the ultimate fallback so a partially-populated `source`
  // (e.g. a bundled entry from an older codex release that omits a field)
  // still lands on a valid value.
  const inputModalities = (model.chat?.modalities?.input
    ?? source.input_modalities
    ?? BASELINE.input_modalities) as readonly Modality[];
  const hasImage = inputModalities.includes('image');

  // Lossy projection: Codex CLI's catalog wire can only model effort-tiered
  // reasoning (`supported_reasoning_levels: [{effort, description}]` +
  // `default_reasoning_level`), mirroring the ModelInfo fields
  // `supported_reasoning_levels: Vec<ReasoningEffortPreset>` and
  // `default_reasoning_level: Option<ReasoningEffort>`
  // (https://github.com/openai/codex/blob/f66d793a2d78287c8c28a5f41f39c58ac49bcc25/codex-rs/protocol/src/openai_models.rs#L356-L357).
  // Floway's `chat.reasoning` is richer: `budget_tokens`, `adaptive`, and
  // `mandatory` don't fit the Codex wire and are silently dropped here. The
  // omission is benign at request-time: Codex CLI sends `reasoning.effort`
  // from the global default, and Floway's translation layer maps that
  // effort value into the appropriate upstream representation (e.g.
  // Anthropic `thinking.budget_tokens`).
  const registryEffort = model.chat?.reasoning?.effort;
  const supportedReasoning = registryEffort !== undefined
    ? registryEffort.supported.map(effort => ({ effort, description: '' }))
    : (source.supported_reasoning_levels ?? BASELINE.supported_reasoning_levels);

  const registryWindow = model.limits.max_context_window_tokens;
  const contextWindow = (registryWindow
    ?? source.context_window
    ?? BASELINE.context_window) as number;
  const maxContextWindow = (registryWindow
    ?? source.max_context_window
    ?? BASELINE.max_context_window) as number;

  const entry: CatalogModel = {
    ...source,
    slug: model.id,
    display_name: model.display_name ?? source.display_name ?? model.id,
    input_modalities: [...inputModalities],
    supports_image_detail_original: hasImage,
    web_search_tool_type: hasImage ? 'text_and_image' : 'text',
    supported_reasoning_levels: supportedReasoning,
    service_tiers: deriveServiceTiers(model),
    context_window: contextWindow,
    max_context_window: maxContextWindow,
  };

  // `default_reasoning_level` pairs with `supported_reasoning_levels` — both
  // come from the same source. When registry supplied `effort`, its schema
  // requires both fields together; otherwise the bundled pair rides through
  // from the spread untouched.
  if (registryEffort !== undefined) {
    entry.default_reasoning_level = registryEffort.default;
  }

  // Miss-path `base_instructions` names the underlying model id so
  // introspection questions ("what model are you?") resolve against the
  // actual routed model instead of confabulating a GPT-5 lineage from the
  // "Codex" persona. Bundled entries keep their upstream-vendored prompt
  // (accurate for the GPT-5 family they were shipped for).
  if (base === undefined) {
    entry.base_instructions = synthesizedBaseInstructions(model.id, model.display_name ?? model.id);
  }

  return entry;
};
