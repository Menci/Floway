// Maps Floway public model catalog to Pi coding agent static model definitions.
//
// Pi has no model discovery for models.json, so Floway serves a static snapshot
// of models visible to the lease's API key.
//
// Mapping rules:
// - Excludes models where kind !== 'chat' (Pi only routes chat models).
// - id: model.id.
// - name: model.display_name (fallback to id if empty).
// - reasoning: true when chat.reasoning advertises any capability (effort levels,
//   token budget, adaptive, or mandatory); omitted otherwise.
// - input: from chat.modalities.input restricted to 'text' and 'image' (default ['text']).
// - contextWindow: limits.max_context_window_tokens when defined (omit otherwise).
// - maxTokens: limits.max_output_tokens when defined (omit otherwise).
// - cost: mapped from pricing base entry scaled from USD per token to USD per
//   million tokens; zeros otherwise (Pi defaults require cost object with
//   input, output, cacheRead, cacheWrite).
// - no compat flags.
// - stable ordering by model id.

import type { PublicModel } from '@floway-dev/protocols/common';

export interface PiModelCost {
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
}

export interface PiModelDefinition {
  id: string;
  name: string;
  reasoning?: boolean;
  input: ('text' | 'image')[];
  cost: PiModelCost;
  contextWindow?: number;
  maxTokens?: number;
}

export interface PiModelsSnapshotResponse {
  models: PiModelDefinition[];
}

const mapRateToPerMillion = (rate: string | undefined): number => {
  if (!rate) return 0;
  const num = Number(rate) * 1_000_000;
  return Number.isFinite(num) && num >= 0 ? num : 0;
};

const mapCost = (model: PublicModel): PiModelCost => {
  // Decision on pricing:
  // Floway stores price vectors per 1 base unit (token) as DecimalString values.
  // Pi's cost schema requires USD per million tokens: { input, output, cacheRead, cacheWrite }.
  // When a unique base entry (no coordinate selector) is found in pricing.entries,
  // we scale token rates by 1,000,000. If pricing is absent or does not have a clean
  // base entry, we default all 4 metrics to 0 matching Pi's default zero rates.
  const baseEntry = model.pricing?.entries?.find(e => !e.selector || Object.keys(e.selector).length === 0);
  if (!baseEntry?.rates) {
    return { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 };
  }

  return {
    input: mapRateToPerMillion(baseEntry.rates.input_tokens),
    output: mapRateToPerMillion(baseEntry.rates.output_tokens),
    cacheRead: mapRateToPerMillion(baseEntry.rates.input_cache_read_tokens),
    cacheWrite: mapRateToPerMillion(baseEntry.rates.input_cache_write_tokens),
  };
};

export const toPiModel = (model: PublicModel): PiModelDefinition => {
  const result: PiModelDefinition = {
    id: model.id,
    name: model.display_name !== '' ? model.display_name : model.id,
    input: ['text'],
    cost: mapCost(model),
  };

  // Modalities: restricted to text and image, defaulting to ['text']
  const rawInput = model.chat?.modalities?.input;
  if (rawInput && rawInput.length > 0) {
    const filtered = rawInput.filter((m): m is 'text' | 'image' => m === 'text' || m === 'image');
    result.input = filtered.length > 0 ? [...filtered] : ['text'];
  }

  // Reasoning: true if chat.reasoning advertises effort, token budget, adaptive, or mandatory
  const reasoning = model.chat?.reasoning;
  if (reasoning) {
    const hasEffort = Boolean(reasoning.effort?.supported && reasoning.effort.supported.length > 0);
    const hasBudget = reasoning.budget_tokens !== undefined;
    const isAdaptive = reasoning.adaptive === true;
    const isMandatory = reasoning.mandatory === true;
    if (hasEffort || hasBudget || isAdaptive || isMandatory) {
      result.reasoning = true;
    }
  }

  // Context window & output limits
  if (model.limits.max_context_window_tokens !== undefined) {
    result.contextWindow = model.limits.max_context_window_tokens;
  }
  if (model.limits.max_output_tokens !== undefined) {
    result.maxTokens = model.limits.max_output_tokens;
  }

  return result;
};

/**
 * Filter and map public models into the static snapshot container for Pi.
 */
export const toPiCatalog = (models: readonly PublicModel[]): PiModelsSnapshotResponse => {
  const chatModels = models.filter(m => m.kind === 'chat');
  const mapped = chatModels.map(toPiModel);
  mapped.sort((a, b) => a.id.localeCompare(b.id));
  return { models: mapped };
};
