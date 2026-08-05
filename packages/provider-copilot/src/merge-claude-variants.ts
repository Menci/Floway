// Merge Claude reasoning-effort and 1M-context variants into a single base id
// for /v1/models surfacing. The data plane keeps requesting upstream by their
// real ids — each provider still resolves the raw variant from request fields
// before calling upstream. This merge is purely an outbound view so
// OpenAI/Anthropic-shaped clients see one Claude model id per family.
//
// Field policy:
//   id, version                                             -> public base id
//   name, display_name                                      -> base display fields
//   capabilities.limits.max_*_tokens                        -> max across siblings
//   capabilities.supports.reasoning_effort                  -> union (consumed by
//                                                             the raw selector)
//   everything else                                         -> identical across
//                                                             siblings, taken
//                                                             from base

import { copilotPublicModelId } from './model-name.ts';
import type { CopilotModelsResponse, CopilotRawModel } from './types.ts';

const isClaudeModel = (model: CopilotRawModel): boolean => model.id.startsWith('claude-');

const maxOf = (...values: (number | undefined)[]): number | undefined => {
  const defined = values.filter((v): v is number => typeof v === 'number');
  return defined.length > 0 ? Math.max(...defined) : undefined;
};

const unionStrings = (...lists: (readonly string[] | undefined)[]): string[] | undefined => {
  const seen: string[] = [];
  let saw = false;
  for (const list of lists) {
    if (!list) continue;
    saw = true;
    for (const v of list) if (!seen.includes(v)) seen.push(v);
  }
  return saw ? seen : undefined;
};

const pickBase = (variants: CopilotRawModel[]): CopilotRawModel => {
  const baseId = copilotPublicModelId(variants[0].id);
  const exact = variants.find(m => m.id === baseId);
  if (exact) return exact;
  // No exact base id (e.g. only suffixed variants exist); pick the shortest id
  // so the variant closest to the base wins.
  return [...variants].sort((a, b) => a.id.length - b.id.length)[0];
};

const mergeVariantGroup = (variants: CopilotRawModel[]): CopilotRawModel => {
  const base = pickBase(variants);
  const baseId = copilotPublicModelId(base.id);
  const displayName = base.display_name ?? base.name ?? baseId;
  const limits = base.capabilities?.limits ?? {};
  const supports = base.capabilities?.supports ?? {};

  return {
    ...base,
    id: baseId,
    name: displayName,
    version: baseId,
    display_name: displayName,
    capabilities: {
      ...base.capabilities,
      limits: {
        ...limits,
        max_context_window_tokens: maxOf(...variants.map(v => v.capabilities?.limits?.max_context_window_tokens)),
        max_prompt_tokens: maxOf(...variants.map(v => v.capabilities?.limits?.max_prompt_tokens)),
        max_output_tokens: maxOf(...variants.map(v => v.capabilities?.limits?.max_output_tokens)),
      },
      supports: {
        ...supports,
        reasoning_effort: unionStrings(...variants.map(v => v.capabilities?.supports?.reasoning_effort)),
      },
    },
  };
};

export const mergeClaudeVariants = (models: CopilotModelsResponse): CopilotModelsResponse => {
  const groups = new Map<string, CopilotRawModel[]>();
  const order: Array<
    | { readonly kind: 'claude'; readonly key: string }
    | { readonly kind: 'opaque'; readonly model: CopilotRawModel }
  > = [];

  for (const model of models.data) {
    if (!isClaudeModel(model)) {
      order.push({ kind: 'opaque', model });
      continue;
    }
    const key = copilotPublicModelId(model.id);
    if (!groups.has(key)) {
      groups.set(key, []);
      order.push({ kind: 'claude', key });
    }
    groups.get(key)!.push(model);
  }

  return {
    object: models.object,
    data: order.map(item => item.kind === 'opaque' ? item.model : mergeVariantGroup(groups.get(item.key)!)),
  };
};
