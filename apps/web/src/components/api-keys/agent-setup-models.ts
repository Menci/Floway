import type { ControlPlaneModel } from '../../api/types';
import { addressableModelId } from '@floway-dev/agent-setup/models';

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

// The `[1m]` suffix is stated once, in the shared projection, because the
// editors need the same reconstruction: a merged Copilot row reports the 1M
// variant's window, and only the suffix carries the beta that reaches it.

export const buildAgentModelOptions = (
  models: readonly ControlPlaneModel[],
  ranking: AgentModelRanking,
): AgentModelOption[] => {
  const options: AgentModelOption[] = [];
  const values = new Set<string>();
  for (const model of rankAgentSetupModels(models, ranking)) {
    const value = ranking.family === 'claude'
      ? addressableModelId(model)
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

// The projection itself belongs to the gateway: it embeds the result in the
// setup script, so a preview built from a second implementation could show a
// document a setup run would never write. The dashboard renders exactly what
// the script carries.
export { addressVSCodeModels, addressableModelId, projectVSCodeModels, projectZedModels, type VSCodeApiType, type VSCodeModel, type ZedModel } from '@floway-dev/agent-setup/models';
