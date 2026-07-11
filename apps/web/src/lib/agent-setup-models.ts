// Pure model-selection helpers for the Agent Setup page. Every selector retains
// the full addressable chat catalog; family matching only re-orders it so the
// agent's own family surfaces first. Model ids and Codex reasoning-effort values
// stay opaque — nothing here narrows a protocol slot to a fixed vendor family.

import type { PublicModel, PublicModelLimits } from '../api/types.ts';

export type AgentFamily = 'claude' | 'codex';

// A model select binds v-model to this `value`. The empty sentinel maps to the
// configuration's `null` ("no override"); a real option carries the id in the
// form that gets persisted; a restored id no longer in the catalog rides along
// as an `unavailable` option so reopening the page never silently drops it.
export const MODEL_OVERRIDE_NONE = '';

export interface ModelOption {
  value: string;
  // The raw, opaque model id for display, or null for the "no override" option.
  modelId: string | null;
  unavailable: boolean;
}

// These matchers affect picker rank only; every addressable chat id remains in
// both pickers. Claude Code discovers gateway models under Claude-family names,
// while Codex's catalog-driven picker applies native behavior to GPT-5/Codex
// slugs. A provider prefix may precede the family segment in Floway's addressable
// ids, so matching starts at either the whole id or a path segment.
// Refs:
// https://code.claude.com/docs/en/llm-gateway-protocol#request-and-response
// https://github.com/openai/codex/blob/c4318c386de365bd0dd9595a08d55a30bb142d11/codex-rs/tui/src/chatwidget/model_popups.rs#L158-L168
// https://github.com/openai/codex/blob/c4318c386de365bd0dd9595a08d55a30bb142d11/codex-rs/models-manager/src/model_presets.rs#L1-L6
const NATIVE_MATCHERS: Record<AgentFamily, RegExp> = {
  claude: /(?:^|\/)claude-/i,
  codex: /(?:^|\/)(?:gpt-5(?:$|[.\-])|codex-)/i,
};

// Filter to chat models, drop duplicate ids (first occurrence wins), then stable-
// partition native-family ids ahead of the rest. `Array.prototype.filter`
// preserves source order, so relative order inside each bucket is deterministic.
export const rankAgentSetupModels = (
  models: readonly PublicModel[],
  family: AgentFamily,
): PublicModel[] => {
  const seen = new Set<string>();
  const chat = models.filter(model => {
    if (model.kind !== 'chat' || seen.has(model.id)) return false;
    seen.add(model.id);
    return true;
  });
  const matcher = NATIVE_MATCHERS[family];
  return [
    ...chat.filter(model => matcher.test(model.id)),
    ...chat.filter(model => !matcher.test(model.id)),
  ];
};

const ONE_MILLION_CONTEXT_TOKENS = 1_000_000;

// Claude Code opts a session into a model's one-million-token window through a
// `[1m]` id suffix, so the suffix is baked into the persisted override the moment
// a one-million-token model is selected while the picker keeps showing the raw
// id. Family-agnostic: the caller decides which ids are Claude models; this reads
// only the advertised context. The browser is the single place this suffix is
// applied — at selection time — while the gateway treats the persisted id as
// opaque and renders it verbatim. Ref: https://code.claude.com/docs/en/model-config
export const applyClaudeContextSuffix = (modelId: string, limits: PublicModelLimits): string => {
  const contextWindow = limits.max_context_window_tokens
    ?? (limits.max_prompt_tokens ?? 0) + (limits.max_output_tokens ?? 0);
  return contextWindow >= ONE_MILLION_CONTEXT_TOKENS && !modelId.endsWith('[1m]')
    ? `${modelId}[1m]`
    : modelId;
};

// Build the option list for a model select: the nullable "no override" option,
// the ranked catalog, and — only when the restored value is neither the sentinel
// nor already listed — an unavailable-current option so a persisted id that left
// the catalog stays selectable instead of resetting.
export const buildModelOptions = (
  models: readonly PublicModel[],
  currentValue: string | null,
  family: AgentFamily,
): ModelOption[] => {
  const options: ModelOption[] = [{ value: MODEL_OVERRIDE_NONE, modelId: null, unavailable: false }];
  for (const model of rankAgentSetupModels(models, family)) {
    options.push({
      value: family === 'claude' ? applyClaudeContextSuffix(model.id, model.limits) : model.id,
      modelId: model.id,
      unavailable: false,
    });
  }
  if (
    currentValue !== null
    && currentValue !== MODEL_OVERRIDE_NONE
    && !options.some(option => option.value === currentValue)
  ) {
    options.push({ value: currentValue, modelId: currentValue, unavailable: true });
  }
  return options;
};

// Codex reasoning-effort presets a combobox suggests, in the upstream-advertised
// order. The value itself stays opaque: the input retains any non-empty string,
// so suggestions never gate what the operator may submit.
export const codexEffortSuggestions = (model: PublicModel | null | undefined): string[] => {
  const supported = model?.chat?.reasoning?.effort?.supported;
  return supported ? [...supported] : [];
};

// Normalize a Codex effort text input into its persisted form: only the exact
// empty UI sentinel clears the override. Every nonempty upstream-owned value —
// including surrounding whitespace — is preserved byte-for-byte.
export const normalizeEffortInput = (value: string): string | null =>
  value === '' ? null : value;
