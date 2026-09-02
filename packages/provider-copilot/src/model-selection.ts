import { copilotRawModelId, stripClaudeDateSuffix } from './model-name.ts';
import { copilotVariantIndex, type CopilotVariantIndex } from './model-variants.ts';
import type { CopilotModelsResponse, CopilotRawModel } from './types.ts';

// https://github.com/anthropics/anthropic-sdk-typescript/blob/3b45cd3b69c956ac63384fdb09ce1d8109f3fa80/src/resources/beta/beta.ts#L622-L635
export const CONTEXT_1M_BETA = 'context-1m-2025-08-07';

export interface ModelSelectionHints {
  context1m?: boolean;
  reasoningEffort?: string;
  fast?: boolean;
}

const normalizedLookupId = (id: string): string => copilotRawModelId(stripClaudeDateSuffix(id));

const supportsOneMillionContext = (model: CopilotRawModel): boolean => {
  // Trust id-level intent first: Copilot has been observed to report
  // claude-opus-4.7-1m-internal with max_context_window_tokens=200000 even
  // though the variant exists specifically for the 1M-context surface. The
  // explicit-number check used to short-circuit and hide that signal.
  if (/-1m(?:-|$)/.test(model.id)) return true;

  const limits = model.capabilities?.limits;
  const explicit = limits?.max_context_window_tokens;
  if (typeof explicit === 'number') return explicit >= 1_000_000;

  const prompt = limits?.max_prompt_tokens ?? 0;
  const output = limits?.max_output_tokens ?? 0;
  return prompt + output >= 1_000_000;
};

const supportsReasoningEffort = (model: CopilotRawModel, effort: string | undefined): boolean => {
  if (!effort) return true;
  return model.capabilities?.supports?.reasoning_effort?.includes(effort) === true;
};

const byModelPreference = (a: CopilotRawModel, b: CopilotRawModel): number => {
  const aBase = a.id.split('-').length;
  const bBase = b.id.split('-').length;
  return aBase - bBase || a.id.localeCompare(b.id);
};

const firstPreferred = (models: readonly CopilotRawModel[]): CopilotRawModel | undefined => [...models].sort(byModelPreference)[0];

// A narrowing filter that rolls back to the original pool when it would empty
// it. On the OpenAI Responses path that rollback is the feature: OpenAI
// answers an unavailable Fast mode by serving the standard lane and saying
// so, and `callOpenAIResponses` mirrors it. `callAnthropicMessages` never
// reaches the rollback because Anthropic makes Fast Mode a hard contract and
// the entry point pre-checks it.
const narrow = (pool: readonly CopilotRawModel[], predicate: (model: CopilotRawModel) => boolean): readonly CopilotRawModel[] => {
  const filtered = pool.filter(predicate);
  return filtered.length > 0 ? filtered : pool;
};

const chooseVariant = (
  candidates: readonly CopilotRawModel[],
  base: CopilotRawModel | undefined,
  hints: ModelSelectionHints,
  index: CopilotVariantIndex,
): CopilotRawModel | undefined => {
  const effort = hints.reasoningEffort;
  if (!hints.context1m && !effort && !hints.fast) {
    return base ?? firstPreferred(candidates);
  }

  // The accelerated lane narrows the pool first because it has the strongest
  // contract. 1m and effort then layer on top: an explicit 1m request stays
  // within that context family even when its effort cannot be met;
  // effort-only selection prefers 1m variants because they tend to advertise
  // broader effort coverage.
  const pool = hints.fast ? narrow(candidates, model => index.suffixOf(model.id) === 'fast') : candidates;

  if (hints.context1m) {
    const oneMillion = pool.filter(supportsOneMillionContext);
    const oneMillionWithEffort = oneMillion.filter(model => supportsReasoningEffort(model, effort));
    return firstPreferred(oneMillionWithEffort) ?? firstPreferred(oneMillion) ?? firstPreferred(pool) ?? base ?? firstPreferred(candidates);
  }

  const withEffort = pool.filter(model => supportsReasoningEffort(model, effort));
  return firstPreferred(withEffort.filter(supportsOneMillionContext)) ?? firstPreferred(withEffort) ?? firstPreferred(pool) ?? base ?? firstPreferred(candidates);
};

export const resolveCopilotRawModel = (models: CopilotModelsResponse, modelId: string, hints: ModelSelectionHints = {}): CopilotRawModel | undefined => {
  const index = copilotVariantIndex(models.data);
  const normalized = normalizedLookupId(modelId);
  const exact = models.data.find(model => model.id === normalized);

  // An id that already names a lane variant is its own answer: the caller
  // pinned a raw id rather than the merged public model, and honouring it
  // beats re-deriving a lane from request fields.
  if (exact && index.suffixOf(exact.id) !== undefined) return exact;

  const candidates = index.families.get(index.publicIdOf(normalized));
  if (candidates === undefined) return exact;

  return chooseVariant(candidates, exact, hints, index);
};

// Whether the family can serve the accelerated lane at all.
// `callAnthropicMessages` pre-checks this because Anthropic rejects
// `speed: 'fast'` on a model that
// cannot serve it, and Copilot never echoes `usage.speed` for us to notice a
// downgrade afterwards. The OpenAI spelling of the same lane needs no
// pre-check: that upstream reports the tier it served.
export const copilotModelSupportsFastVariant = (rawModels: readonly CopilotRawModel[]): boolean => {
  const index = copilotVariantIndex(rawModels);
  return rawModels.some(model => index.suffixOf(model.id) === 'fast');
};
