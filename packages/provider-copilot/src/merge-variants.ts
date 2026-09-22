// Merge a family's raw lane variants (see `model-variants.ts`) into a single
// public model for /v1/models surfacing. The data plane keeps requesting
// upstream by their real ids — each provider still resolves the raw variant
// from request fields before calling upstream. This merge is purely an
// outbound view so OpenAI/Anthropic-shaped clients see one model id per
// family.
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

import type { CopilotVariantIndex } from './model-variants.ts';
import type { CopilotRawModel } from './types.ts';

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

const pickBase = (publicId: string, variants: CopilotRawModel[]): CopilotRawModel => {
  const exact = variants.find(m => m.id === publicId);
  if (exact) return exact;
  // No exact base id (e.g. only suffixed variants exist); pick the shortest id
  // so the variant closest to the base wins.
  return [...variants].sort((a, b) => a.id.length - b.id.length)[0];
};

const mergeVariantGroup = (publicId: string, variants: CopilotRawModel[]): CopilotRawModel => {
  const base = pickBase(publicId, variants);
  const displayName = base.display_name ?? base.name ?? publicId;
  const limits = base.capabilities?.limits ?? {};
  const supports = base.capabilities?.supports ?? {};

  return {
    ...base,
    id: publicId,
    name: displayName,
    version: publicId,
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

export const mergeCopilotVariants = (index: CopilotVariantIndex): CopilotRawModel[] =>
  [...index.families].map(([publicId, variants]) => mergeVariantGroup(publicId, variants));
