// Matched client-catalog entries retain their model-specific instructions and
// opaque fields. Registry metadata controls the public identity, priced tiers,
// modalities, reasoning and limits. Codex providers additionally supply their
// private default window; other providers expose a single input budget.

import type { CatalogModel, CodexCatalogCapabilities, CodexReasoningLevel, CodexServiceTier } from './catalog.ts';
import { synthesizedBaseInstructions } from './synthesized-base-instructions.ts';
import type { Modality } from '@floway-dev/protocols/common';
import type { InternalModel } from '@floway-dev/provider';
import type { CodexContextWindow } from '@floway-dev/provider-codex';

// Keep the established 128K compaction policy for synthesized models whose
// provider has no published limit. Operators can replace it with a model limit.
const CONSERVATIVE_DEFAULT_CONTEXT_WINDOW = 128_000;

// Current model metadata and legacy wire fields for older Codex clients.
// https://github.com/openai/codex/blob/15fd656ddb55bd82a208fb9f00681880523f5260/codex-rs/protocol/src/openai_models.rs#L404-L511
// https://github.com/openai/codex/blob/15fd656ddb55bd82a208fb9f00681880523f5260/codex-rs/protocol/src/openai_models.rs#L838-L943
// https://github.com/openai/codex/blob/7ca611348db9446711ed16ed81c84095e3721cee/codex-rs/protocol/src/openai_models.rs#L283-L337
const BASELINE = {
  slug: '',
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
  supported_in_api: true,
  // Current clients default summary-parameter support to true; the legacy
  // supports_reasoning_summaries field alone no longer suppresses the parameter.
  // https://github.com/openai/codex/blob/15fd656ddb55bd82a208fb9f00681880523f5260/codex-rs/core/src/client.rs#L873-L887
  supports_reasoning_summary_parameter: false,
  supports_reasoning_summaries: false,
  apply_patch_tool_type: null,
  default_reasoning_summary: 'none',
  model_messages: { instructions_template: '' },
  base_instructions: '',
  experimental_supported_tools: [],
  additional_speed_tiers: [],
  service_tiers: [],
  priority: 0,
  visibility: 'list',
  availability_nux: null,
  upgrade: null,
  // Let Codex derive the threshold from the selected window, including local
  // model_context_window overrides, rather than pinning it to the default.
  // https://github.com/openai/codex/blob/15fd656ddb55bd82a208fb9f00681880523f5260/codex-rs/protocol/src/openai_models.rs#L524-L537
  auto_compact_token_limit: null,
  context_window: CONSERVATIVE_DEFAULT_CONTEXT_WINDOW,
  max_context_window: CONSERVATIVE_DEFAULT_CONTEXT_WINDOW,
} satisfies CatalogModel;

// Every distinct registry serviceTier selector is a billable wire id. Codex
// derives slash-command names from tier display names (`priority` with name
// `Fast` becomes `/fast`), so prefer metadata from the matched model and then
// the rest of the client catalog. Custom ids remain usable through the final
// id-as-name fallback.
// https://github.com/openai/codex/blob/be2951ea34f0d295ed0becf97079f92fa5f6950e/codex-rs/tui/src/chatwidget/service_tiers.rs#L76-L104
const deriveServiceTiers = (
  model: InternalModel,
  modelTiers: readonly CodexServiceTier[],
  catalogTiers: readonly CodexServiceTier[],
): CodexServiceTier[] => {
  const ids = new Set(model.pricing?.entries.flatMap(entry => typeof entry.selector?.serviceTier === 'string' ? [entry.selector.serviceTier] : []) ?? []);
  const modelTierById = new Map(modelTiers.map(tier => [tier.id, tier]));
  const catalogTierById = new Map<string, CodexServiceTier>();
  for (const tier of catalogTiers) {
    if (!catalogTierById.has(tier.id)) catalogTierById.set(tier.id, tier);
  }
  return [...ids].map(id => modelTierById.get(id) ?? catalogTierById.get(id) ?? { id, name: id, description: '' });
};

export const synthesizeCatalogEntry = (
  model: InternalModel,
  base?: CatalogModel,
  capabilities: CodexCatalogCapabilities = {},
  catalogServiceTiers: readonly CodexServiceTier[] = [],
  codexContextWindow?: CodexContextWindow,
): CatalogModel => {
  const source: CatalogModel = base ?? BASELINE;

  const inputModalities = (model.chat?.modalities?.input
    ?? source.input_modalities
    ?? BASELINE.input_modalities) as readonly Modality[];
  const hasImage = inputModalities.includes('image');
  const chatProviderModels = model.providerModels === undefined
    ? undefined
    : Object.values(model.providerModels).filter(providerModel => providerModel.kind === 'chat');
  const imageDetailOriginal = chatProviderModels?.length
    ? chatProviderModels.every(providerModel => providerModel.chat?.image_detail_original === true)
    : model.chat?.image_detail_original === true;

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
  const supportedReasoning: CodexReasoningLevel[] = registryEffort !== undefined
    ? registryEffort.supported.map(effort => ({ effort, description: '' }))
    : (source.supported_reasoning_levels ?? BASELINE.supported_reasoning_levels);
  const ultraReasoningLevel = capabilities.ultraReasoningLevel;
  const advertisedReasoning = ultraReasoningLevel !== undefined
    && supportedReasoning.some(level => level.effort === 'max')
    && !supportedReasoning.some(level => level.effort === 'ultra')
    ? [...supportedReasoning, ultraReasoningLevel]
    : supportedReasoning;
  const shouldEnableUltra = advertisedReasoning !== supportedReasoning;

  const providerLimits = [model.limits.max_context_window_tokens, model.limits.max_prompt_tokens]
    .filter((limit): limit is number => limit !== undefined);
  const providerWindow = providerLimits.length > 0
    ? Math.min(...providerLimits)
    : source.context_window ?? BASELINE.context_window;
  const contextWindow = codexContextWindow?.context_window ?? providerWindow;
  const maxContextWindow = codexContextWindow === undefined
    ? providerWindow
    : codexContextWindow.max_context_window;

  const entry: CatalogModel = {
    ...source,
    slug: model.id,
    display_name: model.display_name ?? source.display_name ?? model.id,
    input_modalities: [...inputModalities],
    supports_image_detail_original: imageDetailOriginal,
    web_search_tool_type: hasImage ? 'text_and_image' : 'text',
    supported_reasoning_levels: advertisedReasoning,
    service_tiers: deriveServiceTiers(model, source.service_tiers ?? [], catalogServiceTiers),
    context_window: contextWindow,
    max_context_window: maxContextWindow,
  };

  // Ultra is a client-local v2 orchestration mode whose wire effort remains
  // Max. The caller supplies this capability only from an exact Codex catalog;
  // a model advertising Max alone does not establish either client behavior.
  if (shouldEnableUltra) entry.multi_agent_version = 'v2';

  // `default_reasoning_level` pairs with `supported_reasoning_levels` — both
  // come from the same source. When registry supplied `effort`, its schema
  // requires both fields together; otherwise the catalog pair rides through
  // from the spread untouched.
  if (registryEffort !== undefined) {
    entry.default_reasoning_level = registryEffort.default;
  }

  if (base === undefined) {
    const instructions = synthesizedBaseInstructions(model.id, model.display_name ?? model.id);
    entry.model_messages = { instructions_template: instructions };
    entry.base_instructions = instructions;
  }

  return entry;
};
