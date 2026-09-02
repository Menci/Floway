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

const catalogIdsOf = (rawModels: readonly CopilotRawModel[]): ReadonlySet<string> => new Set(rawModels.map(model => stripClaudeDateSuffix(model.id)));

// Splits a date-stripped raw id into its base and lane suffix. No two
// suffixes above can match the same id — `-1m-internal` does not end in `-1m`,
// and `-xhigh` does not end in `-high` — so the first match is the only match;
// the loop order is a deterministic tie-break should that ever stop holding.
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
const familyPublicId = (rawId: string, catalogIds: ReadonlySet<string>): string => {
  const dateless = stripClaudeDateSuffix(rawId);
  return copilotPublicModelId(splitVariantSuffix(dateless, catalogIds)?.base ?? dateless);
};

// One resolution of a raw catalog into variant families. Both consumers — the
// outbound `/v1/models` merge and the inbound raw-variant selector — read
// their whole view of which ids belong together from a single index, so the
// id set a lane is judged against can never disagree with the grouping built
// from it. `families` preserves the order in which each family is first seen.
export interface CopilotVariantIndex {
  families: ReadonlyMap<string, CopilotRawModel[]>;
  publicIdOf: (rawId: string) => string;
  // The lane a raw id occupies, or `undefined` when it names a base.
  suffixOf: (rawId: string) => VariantSuffix | undefined;
}

export const copilotVariantIndex = (rawModels: readonly CopilotRawModel[]): CopilotVariantIndex => {
  const catalogIds = catalogIdsOf(rawModels);
  const publicIdOf = (rawId: string): string => familyPublicId(rawId, catalogIds);
  const families = new Map<string, CopilotRawModel[]>();
  for (const model of rawModels) {
    const publicId = publicIdOf(model.id);
    const family = families.get(publicId);
    if (family) family.push(model);
    else families.set(publicId, [model]);
  }
  return {
    families,
    publicIdOf,
    suffixOf: rawId => splitVariantSuffix(stripClaudeDateSuffix(rawId), catalogIds)?.suffix,
  };
};
