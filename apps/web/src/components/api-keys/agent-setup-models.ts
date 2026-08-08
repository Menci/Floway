import type { ControlPlaneModel } from '../../api/types';

export type ClaudePicker = 'default' | 'fable' | 'opus' | 'sonnet' | 'haiku';
type ClaudeTier = 'fable' | 'opus' | 'sonnet' | 'haiku' | 'other';
export type AgentModelRanking =
  | { family: 'claude'; picker: ClaudePicker }
  | { family: 'codex' };

export interface AgentModelOption {
  value: string;
  publicModelId: string;
}

const CLAUDE_DEFAULT_ORDER: readonly ClaudeTier[] = ['fable', 'opus', 'sonnet', 'haiku', 'other'];
const claudeTier = (id: string): ClaudeTier => {
  const segment = id.toLowerCase().split('/').find(part => part.startsWith('claude-'));
  if (!segment) return 'other';
  return (['fable', 'opus', 'sonnet', 'haiku'] as const)
    .find(candidate => segment.includes(`-${candidate}`)) ?? 'other';
};
const claudeOrder = (picker: ClaudePicker): readonly ClaudeTier[] => picker === 'default'
  ? CLAUDE_DEFAULT_ORDER
  : [picker, ...CLAUDE_DEFAULT_ORDER.filter(tier => tier !== picker)];

interface CodexModelParts { version: string; variantRank: number }

// Rank 3 is reserved for the plain model: capability tiers precede it, smaller
// variants follow. https://openai.com/index/gpt-5-6/
// https://platform.openai.com/docs/models
const CODEX_VARIANT_RANK: Record<string, number> = { sol: 0, terra: 1, luna: 2, mini: 4, nano: 5 };
const codexModelParts = (id: string): CodexModelParts | null => {
  const segment = id.toLowerCase().split('/').at(-1)!;
  const match = /^gpt-(\d+(?:\.\d+)*)(.*)$/.exec(segment);
  if (!match) return null;
  const suffix = match[2]!.replace(/^[.-]+/, '');
  if (!suffix) return { version: match[1]!, variantRank: 3 };
  const variant = suffix.split(/[.-]/)[0]!;
  return { version: match[1]!, variantRank: CODEX_VARIANT_RANK[variant] ?? 6 };
};

export const rankAgentSetupModels = (
  models: readonly ControlPlaneModel[],
  ranking: AgentModelRanking,
): ControlPlaneModel[] => {
  const seen = new Set<string>();
  const chat = models.filter(model => {
    if (model.kind !== 'chat' || seen.has(model.id)) return false;
    seen.add(model.id);
    return true;
  });

  if (ranking.family === 'claude') {
    const priorities = new Map(claudeOrder(ranking.picker).map((tier, index) => [tier, index]));
    return chat.map((model, index) => ({ model, index, priority: priorities.get(claudeTier(model.id))! }))
      .sort((left, right) => left.priority - right.priority || left.index - right.index)
      .map(entry => entry.model);
  }

  const entries = chat.map((model, index) => ({ model, index, parts: codexModelParts(model.id) }));
  const versionOrder = new Map<string, number>();
  for (const entry of entries) {
    if (entry.parts && !versionOrder.has(entry.parts.version)) versionOrder.set(entry.parts.version, versionOrder.size);
  }
  return entries.sort((left, right) => {
    if (!left.parts || !right.parts) {
      if (!left.parts && right.parts) return 1;
      if (left.parts && !right.parts) return -1;
      return left.index - right.index;
    }
    const versionDifference = versionOrder.get(left.parts.version)! - versionOrder.get(right.parts.version)!;
    return versionDifference || left.parts.variantRank - right.parts.variantRank || left.index - right.index;
  }).map(entry => entry.model);
};

const ONE_MILLION_CONTEXT_TOKENS = 1_000_000;

// The docs name the `[1m]` suffix only for the pinned opus and sonnet
// variables, but its whole wire effect is a `context-1m-2025-08-07` beta added
// behind a test with no family condition, so every picker is offered the window
// its model reports. https://code.claude.com/docs/en/model-config
const claudeModelOverride = (model: ControlPlaneModel): string => {
  const contextWindow = model.limits.max_context_window_tokens
    ?? (model.limits.max_prompt_tokens ?? 0) + (model.limits.max_output_tokens ?? 0);
  return contextWindow >= ONE_MILLION_CONTEXT_TOKENS && !model.id.endsWith('[1m]')
    ? `${model.id}[1m]`
    : model.id;
};

export const buildAgentModelOptions = (
  models: readonly ControlPlaneModel[],
  ranking: AgentModelRanking,
): AgentModelOption[] => {
  const options: AgentModelOption[] = [];
  const values = new Set<string>();
  for (const model of rankAgentSetupModels(models, ranking)) {
    const value = ranking.family === 'claude'
      ? claudeModelOverride(model)
      : model.id;
    if (values.has(value)) continue;
    values.add(value);
    options.push({ value, publicModelId: model.id });
  }
  return options;
};

export const modelOptions = (models: ControlPlaneModel[], family: 'claude' | 'codex', picker: ClaudePicker) =>
  buildAgentModelOptions(models, family === 'claude' ? { family, picker } : { family })
    .map(option => ({ value: option.value, label: option.publicModelId }));

// One entry of Zed's `available_models`. `name` and `max_tokens` are required
// by Zed; `capabilities` is `#[serde(default)]` but its three booleans carry no
// per-field default, so a partial object fails the whole provider.
// Ref: https://github.com/zed-industries/zed/blob/cc053a4a6fa2fd0e8793201ed9099466af1be0b1/crates/settings_content/src/language_model.rs#L49-L87
export interface AgentSetupZedModel {
  name: string;
  display_name: string;
  max_tokens: number;
  max_output_tokens?: number;
  capabilities: { tools: boolean; images: boolean; prompt_caching: boolean };
  mode?: { type: 'adaptive' } | { type: 'thinking'; budget_tokens: number };
}

// Zed requires `max_tokens` and does no token counting of its own, so a model
// whose catalog states no window still needs a number. This is the window Zed's
// own Anthropic-compatible provider assumes for an unknown model.
// Ref: https://github.com/zed-industries/zed/blob/cc053a4a6fa2fd0e8793201ed9099466af1be0b1/crates/anthropic/src/anthropic.rs#L60-L74
const ZED_FALLBACK_CONTEXT_TOKENS = 200_000;

// Thinking mode carries a budget or is not written at all: Zed serializes
// `Thinking::Enabled.budget_tokens` with no skip_serializing_if, so a mode
// without one puts `"budget_tokens": null` on the Messages request and every
// call 400s. The floor is preferred over the ceiling because Zed sends the
// value verbatim on every request and Anthropic requires it below max_tokens.
// Ref: https://github.com/zed-industries/zed/blob/cc053a4a6fa2fd0e8793201ed9099466af1be0b1/crates/anthropic/src/anthropic.rs#L750-L755
const zedThinkingMode = (reasoning: NonNullable<ControlPlaneModel['chat']>['reasoning']): AgentSetupZedModel['mode'] => {
  if (reasoning === undefined) return undefined;
  if (reasoning.adaptive === true) return { type: 'adaptive' };
  const budget = reasoning.budget_tokens?.min ?? reasoning.budget_tokens?.max;
  return budget === undefined ? undefined : { type: 'thinking', budget_tokens: budget };
};

// Selected by `kind`, not by `endpoints`: the endpoint map is the upstream wire
// surface, and translation lets any chat model serve a Messages request. Mirror
// of the installer's jq projection — both write the same document, so this
// reads the catalog the installer sees: the dashboard asks for unlisted rows to
// populate its alias combobox, and `/v1/models` never serves them.
export const buildAgentZedModels = (models: readonly ControlPlaneModel[]): AgentSetupZedModel[] => {
  const entries: AgentSetupZedModel[] = [];
  for (const model of models) {
    if (model.kind !== 'chat' || model.unlisted === true) continue;
    const mode = zedThinkingMode(model.chat?.reasoning);
    entries.push({
      name: model.id,
      display_name: model.display_name,
      max_tokens: model.limits.max_context_window_tokens
        ?? model.limits.max_prompt_tokens
        ?? ZED_FALLBACK_CONTEXT_TOKENS,
      capabilities: {
        // A chat model that cannot call tools is not one anyone routes here.
        tools: true,
        images: model.chat?.modalities?.input.includes('image') ?? false,
        // Zed defaults this off, which suppresses cache_control breakpoints
        // entirely; on, it marks where the stable prefix ends.
        prompt_caching: true,
      },
      // Ordered after capabilities to match the installers byte for byte, so a
      // pasted snippet diffs clean against what a setup run wrote.
      ...(model.limits.max_output_tokens == null ? {} : { max_output_tokens: model.limits.max_output_tokens }),
      ...(mode === undefined ? {} : { mode }),
    });
  }
  return entries;
};
