// Copilot encodes per-request options as suffixes on a base raw model id
// instead of as request fields, and the request fields are not merely
// redundant — the upstream rejects them. `/responses` answers any
// `service_tier` with HTTP 400
// `{"code":"unsupported_value","param":"service_tier"}`, on the base id and
// the `-fast` id alike, and `/chat/completions` accepts the field only to
// report `service_tier: "default"` back. So the raw id is the sole channel
// for these lanes:
//
//   -fast          the accelerated lane — Anthropic Fast Mode (`speed: 'fast'`)
//                  on Claude, OpenAI priority processing
//                  (`service_tier: 'priority'`) on GPT. The response body of
//                  `gpt-5.6-sol-fast` reports `model: "gpt-5.6-sol"` with
//                  `service_tier: "priority"` and bills at exactly 2× the
//                  base rates, which is what makes it a lane of one model
//                  rather than a model of its own.
//   -1m            the long-context lane
//   -1m-internal   likewise, pre-release spelling
//   -high, -xhigh  reasoning-effort lanes
//
// A suffix denotes a lane only when the base id it leaves behind names a real
// model. That is settled by the catalog the ids came from, with one declared
// exception: Copilot has been observed to publish `claude-opus-4.7-1m-internal`
// with no plain `claude-opus-4.7` sibling, so a Claude id matching the
// canonical `claude-<family>-<version>` shape counts as a base whether or not
// the catalog lists it. Demanding a real base is what keeps `grok-code-fast`
// — a model in its own right, with no `grok-code` anywhere — from being read
// as the accelerated lane of a family that does not exist.

import { copilotPublicModelId, stripClaudeDateSuffix } from './model-name.ts';
import type { CopilotRawModel } from './types.ts';

const VARIANT_SUFFIXES = ['1m-internal', 'xhigh', 'high', '1m', 'fast'] as const;

type VariantSuffix = (typeof VARIANT_SUFFIXES)[number];

const CANONICAL_BASE_ID = /^claude-[a-z0-9-]+-\d+(?:\.\d+)?$/;

// Whether `id` names a base a suffixed sibling may attach to. `catalogIds`
// holds the date-stripped raw ids of the catalog under consideration.
const isBaseId = (id: string, catalogIds: ReadonlySet<string>): boolean => catalogIds.has(id) || CANONICAL_BASE_ID.test(id);

// The date-stripped raw ids a family resolution is judged against. Callers
// hold either the whole catalog or the one family's variants; both are a
// closed world for the ids inside them.
export const copilotCatalogIds = (rawModels: readonly CopilotRawModel[]): ReadonlySet<string> => new Set(rawModels.map(model => stripClaudeDateSuffix(model.id)));

// Splits a date-stripped raw id into its base and lane suffix. Suffixes are
// tried longest-first so `-1m-internal` wins over the `-internal` tail it
// contains.
const splitVariantSuffix = (id: string, catalogIds: ReadonlySet<string>): { base: string; suffix: VariantSuffix } | undefined => {
  for (const suffix of VARIANT_SUFFIXES) {
    if (!id.endsWith(`-${suffix}`)) continue;
    const base = id.slice(0, -(suffix.length + 1));
    if (isBaseId(base, catalogIds)) return { base, suffix };
  }
  return undefined;
};

// The public model id a raw variant collapses into: its lane suffix removed,
// then the Claude id spelling normalized. Non-Claude ids that carry no lane
// suffix pass through untouched.
export const copilotFamilyPublicId = (rawId: string, catalogIds: ReadonlySet<string>): string => {
  const dateless = stripClaudeDateSuffix(rawId);
  return copilotPublicModelId(splitVariantSuffix(dateless, catalogIds)?.base ?? dateless);
};

// Groups a raw catalog into one entry per public model id, preserving the
// order in which each family is first seen. The single place that decides
// which raw variants belong together — the outbound `/v1/models` merge and
// the inbound raw-variant selector both read families from here.
export const groupCopilotVariants = (rawModels: readonly CopilotRawModel[]): Map<string, CopilotRawModel[]> => {
  const catalogIds = copilotCatalogIds(rawModels);
  const families = new Map<string, CopilotRawModel[]>();
  for (const model of rawModels) {
    const publicId = copilotFamilyPublicId(model.id, catalogIds);
    const family = families.get(publicId);
    if (family) family.push(model);
    else families.set(publicId, [model]);
  }
  return families;
};

// The lane a raw variant occupies within its own catalog, or `undefined` when
// the id names a base rather than a lane.
export const variantSuffixOf = (rawId: string, catalogIds: ReadonlySet<string>): VariantSuffix | undefined =>
  splitVariantSuffix(stripClaudeDateSuffix(rawId), catalogIds)?.suffix;
