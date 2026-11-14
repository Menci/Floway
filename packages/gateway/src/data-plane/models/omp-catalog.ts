import type { ChatModelInfo, PublicModel, PublicModelsResponse } from '@floway-dev/protocols/common';
import { decimalStringToNumber, multiplyDecimalStrings } from '@floway-dev/protocols/common';

// https://github.com/can1357/oh-my-pi/blob/40e9368ef0458fd9073329cdff4174895f91bc6b/packages/catalog/src/effort.ts
const OMP_EFFORTS = ['minimal', 'low', 'medium', 'high', 'xhigh', 'max'] as const;
type OmpEffort = typeof OMP_EFFORTS[number];

interface OmpThinking {
  mode: 'effort' | 'budget' | 'anthropic-adaptive' | 'anthropic-budget-effort';
  efforts: readonly OmpEffort[];
  defaultLevel?: OmpEffort;
  effortMap?: Partial<Record<OmpEffort, string>>;
  requiresEffort: boolean;
}

// OMP registers these declarations directly; its generic OpenAI discovery drops
// prices and reasoning controls.
// https://github.com/can1357/oh-my-pi/blob/40e9368ef0458fd9073329cdff4174895f91bc6b/packages/coding-agent/src/config/custom-models.ts#L65-L163
export interface OmpModel {
  id: string;
  name: string;
  baseUrl?: string;
  api: `floway:${string}` | 'openai-embeddings' | 'openai-images';
  kind: 'chat' | 'embedding' | 'image';
  reasoning: boolean;
  thinking?: OmpThinking;
  input: readonly ('text' | 'image')[];
  contextWindow: number;
  maxTokens: number;
  cost: { input: number; output: number; cacheRead: number; cacheWrite: number };
  compat: {
    supportsReasoningEffort: boolean;
    supportsDeveloperRole: true;
    supportsStore: false;
    supportsImageDetailOriginal?: boolean;
    reasoningEffortMap?: Partial<Record<OmpEffort, string>>;
  };
}

// https://github.com/can1357/oh-my-pi/blob/40e9368ef0458fd9073329cdff4174895f91bc6b/packages/utils/src/dirs.ts#L33-L37
export const isOmpUserAgent = (userAgent: string | undefined): boolean => userAgent?.startsWith('omp/') === true;

const thinkingFor = (reasoning: ChatModelInfo['reasoning']): OmpThinking | undefined => {
  if (reasoning === undefined) return undefined;
  const hasBudget = reasoning.budget_tokens !== undefined;
  const isAdaptive = reasoning.adaptive === true;
  const declared = reasoning.effort;
  const slots = new Map<OmpEffort, string>();
  if (declared !== undefined) {
    const wireEfforts = [...new Set(declared.supported.filter(effort => reasoning.mandatory === true || (effort !== 'none' && effort !== 'off')))];
    if (wireEfforts.length > OMP_EFFORTS.length) throw new Error('OMP supports at most six selectable reasoning efforts.');
    for (const effort of OMP_EFFORTS) if (wireEfforts.includes(effort)) slots.set(effort, effort);
    if (wireEfforts.includes(declared.default) && ![...slots.values()].includes(declared.default) && !slots.has('medium')) slots.set('medium', declared.default);
    for (const wireEffort of wireEfforts) {
      if ([...slots.values()].includes(wireEffort)) continue;
      const slot = OMP_EFFORTS.find(effort => !slots.has(effort))!;
      slots.set(slot, wireEffort);
    }
  }
  const efforts = declared === undefined
    ? (isAdaptive ? ['high' as const] : hasBudget ? OMP_EFFORTS : reasoning.mandatory === true ? ['minimal' as const] : [])
    : OMP_EFFORTS.filter(effort => slots.has(effort));
  if (efforts.length === 0) return undefined;
  const defaultLevel = declared === undefined ? undefined : efforts.find(effort => slots.get(effort) === declared.default);
  const effortMap = Object.fromEntries([...slots].filter(([slot, wire]) => slot !== wire)) as Partial<Record<OmpEffort, string>>;
  const mode = isAdaptive
    ? 'anthropic-adaptive'
    : hasBudget
      ? (reasoning.effort === undefined ? 'budget' : 'anthropic-budget-effort')
      : 'effort';
  return {
    mode,
    efforts,
    ...(defaultLevel === undefined ? {} : { defaultLevel }),
    ...(Object.keys(effortMap).length === 0 ? {} : { effortMap }),
    requiresEffort: reasoning.mandatory === true,
  };
};

export const toOmpModel = (model: PublicModel, provider: string): OmpModel | null => {
  if (model.kind !== 'chat' && model.kind !== 'embedding' && model.kind !== 'image') return null;
  const reasoning = model.chat?.reasoning;
  let thinking: OmpThinking | undefined;
  try {
    thinking = model.kind === 'chat' ? thinkingFor(reasoning) : undefined;
  } catch (error) {
    throw new Error(`Cannot adapt OMP model ${JSON.stringify(model.id)}: ${error instanceof Error ? error.message : String(error)}`, { cause: error });
  }
  const baseRates = model.pricing === undefined ? {} : model.pricing.entries.find(entry => entry.selector === undefined || Object.keys(entry.selector).length === 0)!.rates;
  const rate = (metric: 'input_tokens' | 'output_tokens' | 'input_cache_read_tokens' | 'input_cache_write_tokens'): number =>
    baseRates[metric] === undefined ? 0 : decimalStringToNumber(multiplyDecimalStrings(baseRates[metric], '1000000'));
  return {
    id: model.id,
    name: model.display_name,
    kind: model.kind,
    api: model.kind === 'embedding' ? 'openai-embeddings' : model.kind === 'image' ? 'openai-images' : `floway:${provider}`,
    reasoning: thinking !== undefined || reasoning?.mandatory === true,
    ...(thinking === undefined ? {} : { thinking }),
    input: model.chat?.modalities?.input ?? ['text'],
    // The defaults match OMP's explicit custom-model registration. Declaring
    // them prevents same-id bundled vendor rows from supplying unrelated caps.
    // https://github.com/can1357/oh-my-pi/blob/40e9368ef0458fd9073329cdff4174895f91bc6b/packages/coding-agent/src/config/custom-models.ts#L143-L144
    contextWindow: model.limits.max_context_window_tokens ?? 128000,
    maxTokens: model.limits.max_output_tokens ?? 16384,
    cost: { input: rate('input_tokens'), output: rate('output_tokens'), cacheRead: rate('input_cache_read_tokens'), cacheWrite: rate('input_cache_write_tokens') },
    compat: {
      supportsReasoningEffort: reasoning?.effort !== undefined, supportsDeveloperRole: true, supportsStore: false,
      ...(model.chat?.image_detail_original === undefined ? {} : { supportsImageDetailOriginal: model.chat.image_detail_original }),
      ...(thinking?.effortMap === undefined ? {} : { reasoningEffortMap: thinking.effortMap }),
    },
  };
};

// OMP's native Anthropic dispatcher reads per-call thinkingBudgets, not the
// model's effortBudgets. Keep its documented presets inside reported bounds.
// https://github.com/can1357/oh-my-pi/blob/40e9368ef0458fd9073329cdff4174895f91bc6b/packages/ai/src/stream.ts#L1601-L1608
// https://github.com/can1357/oh-my-pi/blob/40e9368ef0458fd9073329cdff4174895f91bc6b/packages/ai/src/stream.ts#L1880-L1882
const BUDGET_PRESETS: Record<OmpEffort, number> = { minimal: 1024, low: 4096, medium: 8192, high: 16384, xhigh: 32768, max: 32768 };
// OMP reserves this answer buffer when a reasoning budget shares max_tokens.
// https://github.com/can1357/oh-my-pi/blob/40e9368ef0458fd9073329cdff4174895f91bc6b/packages/ai/src/stream.ts#L1920-L1928
const OUTPUT_BUDGET_BUFFER = 4000;

export const toOmpCatalog = (response: PublicModelsResponse, gatewayUrl: string, provider: string) => {
  const models: OmpModel[] = [];
  const wireApis: Record<string, 'openai-responses' | 'anthropic-messages'> = Object.create(null) as Record<string, 'openai-responses' | 'anthropic-messages'>;
  const streamOptions: Record<string, { thinkingBudgets?: Record<OmpEffort, number> }> = Object.create(null) as Record<string, { thinkingBudgets?: Record<OmpEffort, number> }>;
  const payloadRemovals: Record<string, string[][]> = Object.create(null) as Record<string, string[][]>;
  for (const model of response.data) {
    const projected = toOmpModel(model, provider);
    if (projected === null) continue;
    models.push(projected);
    if (model.kind !== 'chat') continue;
    const reasoning = model.chat?.reasoning;
    payloadRemovals[model.id] = reasoning?.adaptive === true && reasoning.effort === undefined ? [['output_config', 'effort']] : [];
    wireApis[model.id] = reasoning?.budget_tokens !== undefined || reasoning?.adaptive === true ? 'anthropic-messages' : 'openai-responses';
    projected.baseUrl = wireApis[model.id] === 'anthropic-messages' ? gatewayUrl : `${gatewayUrl}/v1`;
    const budget = reasoning?.budget_tokens;
    const budgetMaximum = Math.min(budget?.max ?? Number.POSITIVE_INFINITY, projected.maxTokens - OUTPUT_BUDGET_BUFFER);
    if (budget !== undefined && (budgetMaximum < 1024 || (budget.min !== undefined && budget.min > budgetMaximum))) {
      throw new Error(`Cannot adapt OMP model ${JSON.stringify(model.id)}: reasoning budget does not fit its output limit.`);
    }
    streamOptions[model.id] = budget === undefined ? {} : {
      thinkingBudgets: Object.fromEntries(OMP_EFFORTS.map(effort => [
        effort,
        Math.min(budgetMaximum, Math.max(budget.min ?? 0, BUDGET_PRESETS[effort])),
      ])) as Record<OmpEffort, number>,
    };
  }
  return { api: `floway:${provider}` as const, models, wireApis, streamOptions, payloadRemovals };
};
