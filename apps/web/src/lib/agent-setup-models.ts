// Pure model-selection helpers for the Agent Setup card. Every selector retains
// the full addressable chat catalog; family matching only re-orders it so the
// agent's own family surfaces first. Model ids and Codex reasoning-effort values
// stay opaque — nothing here narrows a protocol slot to a fixed vendor family.

import type { PublicModel, PublicModelLimits } from '../api/types.ts';

export type ClaudePicker = 'default' | 'opus' | 'sonnet' | 'haiku';
type ClaudeTier = 'fable' | 'opus' | 'sonnet' | 'haiku' | 'other';
export type AgentModelRanking =
  | { family: 'claude'; picker: ClaudePicker }
  | { family: 'codex' };

// A single selectable model row. `value` is the form that gets persisted (the
// Claude `[1m]` rule is baked in here), while `modelId` is the raw catalog id
// shown as the label. The "no override" choice is not part of this list — the
// picker renders its own Default row.
export interface ModelOption {
  value: string;
  modelId: string;
}

const CLAUDE_DEFAULT_ORDER: readonly ClaudeTier[] = ['fable', 'opus', 'sonnet', 'haiku', 'other'];
const claudeTier = (id: string): ClaudeTier => {
  const segment = id.toLowerCase().split('/').find(part => part.startsWith('claude-'));
  if (!segment) return 'other';
  const tier = (['fable', 'opus', 'sonnet', 'haiku'] as const).find(candidate => segment.includes(`-${candidate}`));
  return tier ?? 'other';
};

const claudeOrder = (picker: ClaudePicker): readonly ClaudeTier[] => picker === 'default'
  ? CLAUDE_DEFAULT_ORDER
  : [picker, ...CLAUDE_DEFAULT_ORDER.filter(tier => tier !== picker)];

interface CodexModelParts {
  version: string;
  variantRank: number;
}

// We normalize two OpenAI naming generations onto one picker order: the GPT-5.6
// capability tiers precede the plain model, while the smaller GPT-5 variants
// follow it. A single model version only uses one of these naming schemes.
// Refs: https://openai.com/index/gpt-5-6/
//       https://platform.openai.com/docs/models
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

// Catalog order breaks ties left equal by the explicit priority rules.
export const rankAgentSetupModels = (
  models: readonly PublicModel[],
  ranking: AgentModelRanking,
): PublicModel[] => {
  const seen = new Set<string>();
  const chat = models.filter(model => {
    if (model.kind !== 'chat' || seen.has(model.id)) return false;
    seen.add(model.id);
    return true;
  });

  if (ranking.family === 'claude') {
    const priorities = new Map(claudeOrder(ranking.picker).map((tier, index) => [tier, index]));
    return chat.map((model, index) => ({ model, index, priority: priorities.get(claudeTier(model.id))! }))
      .sort((a, b) => a.priority - b.priority || a.index - b.index)
      .map(entry => entry.model);
  }

  const entries = chat.map((model, index) => ({ model, index, parts: codexModelParts(model.id) }));
  const versionOrder = new Map<string, number>();
  for (const entry of entries) {
    if (entry.parts !== null && !versionOrder.has(entry.parts.version)) {
      versionOrder.set(entry.parts.version, versionOrder.size);
    }
  }
  return entries.sort((a, b) => {
    if (a.parts === null || b.parts === null) {
      if (a.parts === null && b.parts !== null) return 1;
      if (a.parts !== null && b.parts === null) return -1;
      return a.index - b.index;
    }
    const versionDifference = versionOrder.get(a.parts.version)! - versionOrder.get(b.parts.version)!;
    if (versionDifference !== 0) return versionDifference;
    return a.parts.variantRank - b.parts.variantRank || a.index - b.index;
  }).map(entry => entry.model);
};

const ONE_MILLION_CONTEXT_TOKENS = 1_000_000;

// Claude Code opts a session into a model's one-million-token window through a
// `[1m]` id suffix, so the suffix is baked into the persisted override the moment
// a one-million-token model is selected while the picker keeps showing the raw
// id. The browser is the single place this suffix is applied — at selection time
// — while the gateway treats the persisted id as opaque and renders it verbatim.
// Ref: https://code.claude.com/docs/en/model-config
const claudeModelOverride = (
  modelId: string,
  limits: PublicModelLimits,
  picker: ClaudePicker,
): string => {
  if (picker === 'haiku') return modelId;
  const contextWindow = limits.max_context_window_tokens
    ?? (limits.max_prompt_tokens ?? 0) + (limits.max_output_tokens ?? 0);
  return contextWindow >= ONE_MILLION_CONTEXT_TOKENS && !modelId.endsWith('[1m]')
    ? `${modelId}[1m]`
    : modelId;
};

export const buildModelOptions = (
  models: readonly PublicModel[],
  ranking: AgentModelRanking,
): ModelOption[] => {
  const options: ModelOption[] = [];
  const values = new Set<string>();
  for (const model of rankAgentSetupModels(models, ranking)) {
    const value = ranking.family === 'claude' ? claudeModelOverride(model.id, model.limits, ranking.picker) : model.id;
    if (values.has(value)) continue;
    values.add(value);
    options.push({ value, modelId: model.id });
  }
  return options;
};
