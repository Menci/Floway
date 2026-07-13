// Synthesizes the alias entries that join the real-model catalog inside
// the listing pipeline. Every visible alias becomes one `InternalModel`
// row on the alias-row branch of the discriminated union: metadata
// (`limits`, `chat`, `endpoints`, `pricing`) is computed against the
// currently-available targets, and the `aliasedFrom` sidecar carries the
// operator's alias record so wire-projection layers can render the
// alias-of relationship without a second round trip.
//
// `limits`, `chat`, `endpoints`, and `pricing` are computed against the
// GATEWAY-WIDE addressable surface — every caller sees the same numbers
// for the same alias, independent of their data-plane cap. The operator's
// stored `announced_metadata` override still wins at sub-block
// granularity (a present `limits` / `chat` replaces the computed
// counterpart wholesale, not per-leaf). The intersection is the safe
// lower bound for the inbound request — every reported capability
// survives no matter which target the resolver picks.
//
// The rule-aware part: when an alias's rule pins a value at a target,
// that target is treated as "unsupported" for the corresponding
// sub-field for the purposes of the intersection. A pinned rule
// already fixes whatever value the listing would have advertised, so
// dropping the sub-field from the announced metadata keeps the wire
// surface honest about what the operator left for the caller to set.
//
// Caller-scope (the addressable surface this specific request can
// reach) controls only two things: whether the alias appears in this
// caller's response (at least one target reachable under the cap), and
// the `aliasedFrom.targets` projection when `narrowTargets` is true.
//
// Collision: when an alias's `name` exactly equals a real model id, the
// alias entry replaces the real entry in the final catalog. Two entries
// with the same `id` would break OpenAI client deduplication; collapsing
// to the alias entry preserves the operator's intent (the alias is the
// reason both rows would have been present). The real entry is removed
// at the `mergeAliasesIntoModels` step.

import type { AddressableIdEntry } from './addressable.ts';
import type { ModelAliasRecord } from '../../../repo/types.ts';
import { unionEndpoints } from '../../providers/endpoint-union.ts';
import { composeAliasDisplayName } from '@floway-dev/protocols/common';
import type { AliasTarget, AnnouncedMetadata, ChatModelInfo, PublicModelLimits } from '@floway-dev/protocols/common';
import type { InternalAliasedFrom, InternalModel } from '@floway-dev/provider';

export interface ListedAliasInputs {
  readonly aliases: readonly ModelAliasRecord[];
  // Gateway-wide addressable surface — used for the metadata + endpoints
  // + pricing computations that must be stable across callers. A target
  // resolvable only via an upstream the current caller cannot reach
  // STILL contributes to the safe-lower-bound intersection the catalog
  // publishes, because the same alias must look the same to every
  // user (admin, non-admin, api key).
  readonly gatewayAddressableModelIds: readonly AddressableIdEntry[];
  // Caller-scoped addressable surface. Decides (a) whether this alias
  // is visible to the caller at all (must have at least one target
  // reachable under the caller's cap) and (b) the `aliasedFrom.targets`
  // projection when `narrowTargets` is true. For unrestricted callers
  // (admin gateway-wide) pass the same array as `gatewayAddressableModelIds`.
  readonly callerAddressableModelIds: readonly AddressableIdEntry[];
  // True for callers whose `aliasedFrom.targets` projection must omit
  // any configured target the addressable surface cannot serve — every
  // data-plane response, and non-admin control-plane responses. False
  // for admin sessions on the control plane: the alias-edit dialog
  // needs to see every target the operator wired, including typos and
  // targets on upstreams the admin self-restricted out of, so the
  // configuration is editable end to end.
  readonly narrowTargets: boolean;
}

// Result preserves the order of `arrays[0]`. Matters for callers like the
// reasoning-effort intersection below: when no agreed-default exists, the
// fallback default is `supported[0]`, so the first input's relative order
// determines which level wins as the listing's `default`.
const intersectArrays = <T>(arrays: readonly (readonly T[])[]): T[] => {
  if (arrays.length === 0) return [];
  const [head, ...tail] = arrays;
  return head.filter(value => tail.every(other => other.includes(value)));
};

// All-or-nothing field intersect. Every input must declare a non-undefined
// value for `pick` or the field drops (undefined). When every input carries
// one, `merge` computes the intersected value — which may itself decide to
// drop the field (returning undefined) if the intersection collapses (e.g.
// modalities with an empty side, or a budget window with min > max).
// Every sub-field intersection in this module goes through this — the
// "declared at every target, else drop" invariant is the announced-metadata
// contract, and stating it once per field keeps the individual specs to a
// three-liner each.
const intersectField = <Src, R>(
  items: readonly Src[],
  pick: (src: Src) => R | undefined,
  merge: (values: readonly R[]) => R | undefined,
): R | undefined => {
  if (items.length === 0) return undefined;
  const picked: R[] = [];
  for (const src of items) {
    const v = pick(src);
    if (v === undefined) return undefined;
    picked.push(v);
  }
  return merge(picked);
};

// Apply the rule-driven downgrade: a target with a pinned rule reports
// the corresponding catalog sub-field as unsupported (= undefined) for
// the purposes of intersection. Fields the rule doesn't touch pass
// through unchanged.
const effectiveChatForIntersection = (chat: ChatModelInfo | undefined, target: AliasTarget): ChatModelInfo | undefined => {
  if (chat === undefined) return undefined;
  const ruleReasoning = target.rules.reasoning;
  if (ruleReasoning === undefined) return chat;
  if (chat.reasoning === undefined) return chat;

  const reasoning: NonNullable<ChatModelInfo['reasoning']> = { ...chat.reasoning };
  if (ruleReasoning.effort !== undefined) delete reasoning.effort;
  if (ruleReasoning.budget_tokens !== undefined) delete reasoning.budget_tokens;
  if (ruleReasoning.adaptive === true) delete reasoning.adaptive;

  return { ...chat, reasoning };
};

const intersectReasoning = (
  rs: readonly NonNullable<ChatModelInfo['reasoning']>[],
): NonNullable<ChatModelInfo['reasoning']> | undefined => {
  const result: NonNullable<ChatModelInfo['reasoning']> = {};

  const effort = intersectField(rs, r => r.effort, efforts => {
    const supported = intersectArrays(efforts.map(e => e.supported));
    if (supported.length === 0) return undefined;
    // Intersection's `default` is the agreed value when every target names
    // the same one and that value still survives the supported intersection;
    // otherwise fall back to `supported[0]` (ordered by the first input).
    const defaults = new Set(efforts.map(e => e.default));
    const agreed = defaults.size === 1 ? [...defaults][0] : undefined;
    return { supported, default: agreed !== undefined && supported.includes(agreed) ? agreed : supported[0] };
  });
  if (effort !== undefined) result.effort = effort;

  const budgetTokens = intersectField(rs, r => r.budget_tokens, budgets => {
    // BOTH min and max must be all-declared — a half-declared block would
    // advertise a capability some target does not actually report. Drop the
    // block when the intersected window is empty (contradictory ranges).
    const min = intersectField(budgets, b => b.min, ns => Math.max(...ns));
    const max = intersectField(budgets, b => b.max, ns => Math.min(...ns));
    return min !== undefined && max !== undefined && min <= max ? { min, max } : undefined;
  });
  if (budgetTokens !== undefined) result.budget_tokens = budgetTokens;

  // adaptive / mandatory are `true | undefined` — the intersectField gate
  // already drops the field the moment any target leaves it undeclared, so
  // the merge just re-yields `true`.
  const adaptive = intersectField(rs, r => r.adaptive, () => true as const);
  if (adaptive !== undefined) result.adaptive = adaptive;
  const mandatory = intersectField(rs, r => r.mandatory, () => true as const);
  if (mandatory !== undefined) result.mandatory = mandatory;

  return Object.keys(result).length > 0 ? result : undefined;
};

const intersectChat = (chats: readonly ChatModelInfo[]): ChatModelInfo | undefined => {
  const result: ChatModelInfo = {};

  const modalities = intersectField(chats, c => c.modalities, mods => {
    const input = intersectArrays(mods.map(m => m.input));
    const output = intersectArrays(mods.map(m => m.output));
    // Both halves must survive — an alias that consumes a modality but
    // promises no output (or the inverse) is incoherent.
    return input.length > 0 && output.length > 0 ? { input, output } : undefined;
  });
  if (modalities !== undefined) result.modalities = modalities;

  const reasoning = intersectField(chats, c => c.reasoning, intersectReasoning);
  if (reasoning !== undefined) result.reasoning = reasoning;

  return Object.keys(result).length > 0 ? result : undefined;
};

// `limits` intersection: min across targets per field; the field is
// absent when any target leaves it undeclared. Matches the safe-lower-
// bound contract — whichever target the resolver picks, the reported
// window is one every target can actually serve.
const LIMIT_KEYS = ['max_context_window_tokens', 'max_prompt_tokens', 'max_output_tokens'] as const;

const intersectLimits = (limitsList: readonly PublicModelLimits[]): PublicModelLimits => {
  const result: PublicModelLimits = {};
  for (const key of LIMIT_KEYS) {
    const value = intersectField(limitsList, l => l[key], values => Math.min(...values));
    if (value !== undefined) result[key] = value;
  }
  return result;
};

// `narrowTargets=true` filters `targets` to those the caller's addressable
// surface can serve — protects non-admin / data-plane callers from seeing
// operator state (target IDs from upstreams they have no access to, plus
// typo'd / removed model IDs). `narrowTargets=false` is the admin-debug
// view: every configured target survives so the dashboard's alias editor
// can render the full configuration even when the admin self-restricted.
const buildAliasedFrom = (
  alias: ModelAliasRecord,
  addressableModelIds: readonly AddressableIdEntry[],
  narrowTargets: boolean,
): InternalAliasedFrom => {
  if (!narrowTargets) {
    return { selection: alias.selection, targets: alias.targets };
  }
  const addressableSet = new Set(addressableModelIds.map(entry => entry.id));
  const targets = alias.targets.filter(t => addressableSet.has(t.target_model_id));
  return { selection: alias.selection, targets };
};

// Compute the rule-aware intersection (`limits` + `chat`) over the
// alias's currently-available targets. Caller decides whether to use
// the result directly or overlay it under an operator override.
const computeAutomaticMetadata = (
  availableTargets: readonly { target: AliasTarget; real: InternalModel }[],
): { limits: PublicModelLimits; chat: ChatModelInfo | undefined } => {
  const limits = intersectLimits(availableTargets.map(({ real }) => real.limits));

  const effectiveChats = availableTargets
    .map(({ target, real }) => effectiveChatForIntersection(real.chat, target))
    .filter((c): c is ChatModelInfo => c !== undefined);
  // Intersect chat metadata only when every available target carries it
  // (post-downgrade); a half-declared block would leak the metadata of
  // whichever subset happened to carry it.
  const chat = effectiveChats.length === availableTargets.length
    ? intersectChat(effectiveChats)
    : undefined;

  return { limits, chat };
};

// Merge the operator's override on top of the computed payload at the
// top-level sub-block boundary: a present `limits` / `chat` on the
// override replaces the computed counterpart wholesale; an omitted
// sub-block falls back to the computed value. (Merge is intentionally
// NOT per-leaf — that's the contract `AnnouncedMetadata` advertises.)
const mergeWithOverride = (
  computed: { limits: PublicModelLimits; chat: ChatModelInfo | undefined },
  override: AnnouncedMetadata,
): { limits: PublicModelLimits; chat: ChatModelInfo | undefined } => ({
  limits: override.limits ?? computed.limits,
  chat: override.chat ?? computed.chat,
});

// Returns null when no target serves this alias on the gateway, OR when the
// caller cannot reach any of the configured targets — the catalog should
// never advertise an id the caller would 404 on. The alias itself stays
// addressable through the request-time resolver in `providers/registry.ts`,
// which walks the alias's targets in configured order and surfaces a
// regular model-missing 404 when no target has any kind-matching binding.
// Callers (`synthesizeListedAliases`) filter the nulls out.
const synthesizeOne = (
  alias: ModelAliasRecord,
  gatewayAddressableModelIds: readonly AddressableIdEntry[],
  callerAddressableModelIds: readonly AddressableIdEntry[],
  narrowTargets: boolean,
): InternalModel | null => {
  // Gateway-wide kind-matched targets — the basis for stable metadata.
  // A target reachable only via a prefix-addressable alternate or a
  // provider-side redirect (Copilot variant id) still counts.
  const gatewayById = new Map(gatewayAddressableModelIds.map(entry => [entry.id, entry.model] as const));
  const gatewayAvailable = alias.targets
    .map(target => ({ target, real: gatewayById.get(target.target_model_id) }))
    .filter((entry): entry is { target: AliasTarget; real: InternalModel } => entry.real !== undefined && entry.real.kind === alias.kind);
  if (gatewayAvailable.length === 0) return null;

  // Caller-scope visibility: the alias appears only if at least one
  // gateway-available target sits inside the caller's addressable cap.
  const callerSet = new Set(callerAddressableModelIds.map(entry => entry.id));
  const callerHasAny = gatewayAvailable.some(e => callerSet.has(e.target.target_model_id));
  if (!callerHasAny) return null;

  // Display name precedence: operator-set wins; otherwise derive from the
  // sole target's id + rules when single-target; multi-target falls back to
  // the alias's own name because no single target represents the alias.
  // Uses the configured `alias.targets.length` (stable across callers)
  // rather than the per-caller reachable count.
  const displayName = alias.displayName ?? (alias.targets.length === 1
    ? composeAliasDisplayName(alias.targets[0].target_model_id, alias.targets[0].rules)
    : alias.name);

  // Metadata + endpoints + pricing computed against gateway-wide — every
  // caller sees the same numbers for the same alias, so a non-admin
  // restricted to a subset of upstreams never sees a more permissive
  // limit than the admin who knows the alias's true safe-lower-bound.
  const computed = computeAutomaticMetadata(gatewayAvailable);
  const { limits, chat } = alias.announcedMetadata !== null
    ? mergeWithOverride(computed, alias.announcedMetadata)
    : computed;

  // Endpoints follow the gateway-wide union — every endpoint reachable
  // through ANY gateway target is advertised. The request-time resolver
  // walks the alias's targets in configured order and stops at the first
  // target with kind-matching candidates; a caller hitting an endpoint
  // that's only served by an out-of-cap target sees the natural
  // model-missing / model-unsupported error.
  const endpoints = unionEndpoints(gatewayAvailable.map(({ real }) => real.endpoints));

  const singleTargetPricing = gatewayAvailable.length === 1 ? gatewayAvailable[0].real.pricing : undefined;

  const entry: InternalModel = {
    id: alias.name,
    display_name: displayName,
    limits,
    kind: alias.kind,
    endpoints,
    aliasedFrom: buildAliasedFrom(alias, callerAddressableModelIds, narrowTargets),
    ...(chat !== undefined ? { chat } : {}),
    ...(singleTargetPricing !== undefined ? { pricing: singleTargetPricing } : {}),
  };
  return entry;
};

const sortAliases = (aliases: readonly ModelAliasRecord[]): ModelAliasRecord[] =>
  [...aliases].sort((a, b) => (a.sortOrder - b.sortOrder) || a.name.localeCompare(b.name));

export const synthesizeListedAliases = (input: ListedAliasInputs): InternalModel[] =>
  sortAliases(input.aliases)
    // `visibleInModelsList` is a LISTING flag only — the request-time
    // resolver in `providers/registry.ts` does not consult it, so a hidden
    // alias stays reachable at dispatch. This lets an operator ship a
    // gateway id (e.g. a legacy client hardcodes it) without cluttering
    // the public catalog.
    .filter(alias => alias.visibleInModelsList)
    .map(alias => synthesizeOne(alias, input.gatewayAddressableModelIds, input.callerAddressableModelIds, input.narrowTargets))
    .filter((entry): entry is InternalModel => entry !== null);

// Compose real-model rows with visible alias rows into a single `InternalModel[]`.
// Shared merge point across the alias-aware listing endpoints (OpenAI
// `/v1/models`, Gemini `/v1beta/models`, dashboard `/api/models`); Codex
// `/models` opts out by consuming the real-only catalog directly. Callers
// project the returned rows onto their wire shape with a single mapper
// that reads `.aliasedFrom` off the discriminated union to decide whether
// to emit the alias sidecar. Collision handling is spelled out at the file
// header.
export const mergeAliasesIntoModels = (input: {
  readonly realModels: readonly InternalModel[];
  readonly gatewayAddressableModelIds: readonly AddressableIdEntry[];
  readonly callerAddressableModelIds: readonly AddressableIdEntry[];
  readonly aliases: readonly ModelAliasRecord[];
  readonly narrowTargets: boolean;
}): InternalModel[] => {
  const { realModels, gatewayAddressableModelIds, callerAddressableModelIds, aliases, narrowTargets } = input;
  const aliasEntries = synthesizeListedAliases({
    aliases,
    gatewayAddressableModelIds,
    callerAddressableModelIds,
    narrowTargets,
  });
  const aliasIds = new Set(aliasEntries.map(entry => entry.id));
  return [
    ...realModels.filter(model => !aliasIds.has(model.id)),
    ...aliasEntries,
  ];
};
