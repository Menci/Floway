import { piThinkingLevelMap, type PiThinkingLevel, type PiThinkingLevelMap } from '@floway-dev/agent-setup/pi-thinking';
import type { ChatModelInfo, PriceVector, PublicModel } from '@floway-dev/protocols/common';
import { decimalStringToNumber, multiplyDecimalStrings } from '@floway-dev/protocols/common';

interface PiCostRates {
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
}

export interface PiModel {
  id: string;
  name: string;
  provider: string;
  api: 'openai-responses' | 'anthropic-messages';
  baseUrl: string;
  reasoning: boolean;
  thinkingLevelMap: PiThinkingLevelMap;
  thinkingBudgets?: Record<string, number>;
  effortOverrides?: Partial<Record<PiThinkingLevel, string>>;
  payloadRemovals?: readonly (readonly string[])[];
  input: readonly ('text' | 'image')[];
  contextWindow: number;
  maxTokens: number;
  cost: PiCostRates & { tiers?: (PiCostRates & { inputTokensAbove: number })[] };
  compat?: { forceAdaptiveThinking: true };
}

// These are Pi's documented manual model defaults when limits are unknown.
// https://github.com/earendil-works/pi/blob/1cedd32724abfcb0915f76cc61b6827e2c16dbad/packages/coding-agent/src/core/provider-composer.ts#L232-L247
const PI_DEFAULT_CONTEXT_WINDOW = 128000;
const PI_DEFAULT_MAX_TOKENS = 16384;

const ratePerMillion = (value: string | undefined): number =>
  value === undefined ? 0 : decimalStringToNumber(multiplyDecimalStrings(value, '1000000'));

const piCostRates = (rates: PriceVector): PiCostRates => ({
  input: ratePerMillion(rates.input_tokens),
  output: ratePerMillion(rates.output_tokens),
  cacheRead: ratePerMillion(rates.input_cache_read_tokens),
  cacheWrite: ratePerMillion(rates.input_cache_write_tokens),
});

const piCost = (model: PublicModel): PiModel['cost'] => {
  const entries = model.pricing?.entries ?? [];
  const base = entries.find(entry => Object.keys(entry.selector ?? {}).length === 0);
  const tiers = entries.flatMap(entry => {
    const selector = entry.selector;
    if (selector === undefined || Object.keys(selector).length !== 1) return [];
    const inputTokens = selector.inputTokens;
    if (typeof inputTokens !== 'object') return [];
    return [{
      ...piCostRates(entry.rates),
      inputTokensAbove: inputTokens.value - (inputTokens.operator === 'gte' ? 1 : 0),
    }];
  }).toSorted((a, b) => a.inputTokensAbove - b.inputTokensAbove);
  return { ...piCostRates(base?.rates ?? {}), ...(tiers.length > 0 ? { tiers } : {}) };
};

const piReasoning = (modelId: string, reasoning: ChatModelInfo['reasoning'], maxTokens: number): Pick<PiModel, 'reasoning' | 'thinkingLevelMap' | 'thinkingBudgets' | 'effortOverrides' | 'payloadRemovals' | 'compat'> => {
  const supported = reasoning?.effort?.supported ?? [];
  const hasBudget = reasoning?.budget_tokens !== undefined;
  const enabled = supported.length > 0 || hasBudget || reasoning?.adaptive === true || reasoning?.mandatory === true;
  const mapped = piThinkingLevelMap(reasoning, modelId);
  if (!mapped.supported) throw new Error(mapped.message);
  const thinkingLevelMap = mapped.map;

  // Native Anthropic uses these Pi budget presets; clamp each to the catalog's
  // declared bounds before passing them as the adapter's thinkingBudgets option.
  // https://github.com/earendil-works/pi/blob/1cedd32724abfcb0915f76cc61b6827e2c16dbad/packages/ai/src/api/simple-options.ts
  const budgets = hasBudget ? { minimal: 1024, low: 2048, medium: 8192, high: 16384 } : undefined;
  const budgetFloor = Math.max(1024, reasoning?.budget_tokens?.min ?? 1024);
  const budgetCeiling = Math.min(reasoning?.budget_tokens?.max ?? maxTokens, maxTokens - 1024);
  if (hasBudget && (budgetCeiling < budgetFloor)) {
    throw new Error(`Pi cannot fit the declared reasoning budget and answer tokens for model ${modelId}`);
  }
  const thinkingBudgets = budgets === undefined ? undefined : Object.fromEntries(Object.entries(budgets).map(([level, tokens]) => [
    level,
    Math.min(budgetCeiling, Math.max(budgetFloor, tokens)),
  ]));
  // Pi's adaptive adapter always derives an effort from its thinking slot.
  // A slot used solely as an on switch must not manufacture an effort or erase
  // the independent output-format configuration.
  // https://github.com/earendil-works/pi/blob/1cedd32724abfcb0915f76cc61b6827e2c16dbad/packages/ai/src/api/anthropic-messages.ts#L950-L957
  return {
    reasoning: enabled,
    thinkingLevelMap,
    ...(thinkingBudgets === undefined ? {} : { thinkingBudgets }),
    ...(hasBudget && supported.length > 0 && reasoning?.adaptive !== true ? {
      effortOverrides: Object.fromEntries(Object.entries(thinkingLevelMap).flatMap(([level, effort]) => level === 'off' || effort === null ? [] : [[level, effort]])),
    } : {}),
    ...(reasoning?.adaptive === true && supported.length === 0 ? { payloadRemovals: [['output_config', 'effort']] } : {}),
    ...(reasoning?.adaptive === true ? { compat: { forceAdaptiveThinking: true } as const } : {}),
  };
};

export const toPiCatalog = (models: readonly PublicModel[], baseUrl: string, provider = 'floway'): { models: PiModel[] } => ({
  models: models.filter(model => model.kind === 'chat').map(model => ({
    id: model.id,
    name: model.display_name || model.id,
    provider,
    api: model.chat?.reasoning?.budget_tokens !== undefined || model.chat?.reasoning?.adaptive === true
      ? 'anthropic-messages'
      : 'openai-responses',
    baseUrl: model.chat?.reasoning?.budget_tokens !== undefined || model.chat?.reasoning?.adaptive === true ? baseUrl.replace(/\/v1$/, '') : baseUrl,
    ...piReasoning(model.id, model.chat?.reasoning, model.limits.max_output_tokens ?? PI_DEFAULT_MAX_TOKENS),
    input: model.chat?.modalities?.input ?? ['text'],
    contextWindow: model.limits.max_context_window_tokens ?? PI_DEFAULT_CONTEXT_WINDOW,
    maxTokens: model.limits.max_output_tokens ?? PI_DEFAULT_MAX_TOKENS,
    cost: piCost(model),
  })),
});

// Official Pi discovery and inference User-Agent forms.
// https://github.com/earendil-works/pi/blob/1cedd32724abfcb0915f76cc61b6827e2c16dbad/packages/coding-agent/src/utils/pi-user-agent.ts#L1-L4
// https://github.com/earendil-works/pi/blob/1cedd32724abfcb0915f76cc61b6827e2c16dbad/packages/ai/src/utils/pi-user-agent.ts#L17-L19
export const isPiUserAgent = (userAgent: string | undefined): boolean => /^pi(?:\/| \()/.test(userAgent ?? '');
