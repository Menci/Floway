// Shared catalog lookups + warning computation for the alias dashboard
// surfaces (Settings row, edit dialog, target row). Centralising these
// helpers keeps the Settings card and the dialog reading the same view of
// the live /api/models catalog.

import type { ModelKind, ChatAliasRules, ControlPlaneModel } from '../../api/types.ts';

// Excludes alias rows — target ids never re-enter the alias layer, so the
// rule-warning lookup runs against the real-model surface only.
export const findCatalogModel = (
  models: readonly ControlPlaneModel[] | null | undefined,
  targetModelId: string,
): ControlPlaneModel | undefined =>
  (models ?? []).find(m => m.id === targetModelId && m.aliasedFrom === undefined);

// Real (non-alias) model ids whose kind matches the alias's kind. Used by
// the target-id combobox suggestion list so an embedding alias only
// suggests embedding models, etc. Operators can still type any string —
// the suggestion list is a hint, not a constraint.
export const realModelIdsOfKind = (
  models: readonly ControlPlaneModel[] | null | undefined,
  kind: ModelKind,
): string[] =>
  (models ?? []).filter(m => m.aliasedFrom === undefined && m.kind === kind).map(m => m.id);

// One warning attached to a specific chat rule field.
export interface AliasRuleWarning {
  field: 'reasoning.effort' | 'reasoning.budget_tokens' | 'reasoning.adaptive' | 'reasoning.summary' | 'verbosity' | 'serviceTier';
  message: string;
}

// Rule-level warnings: a configured rule field whose target's chat
// capability metadata does not advertise the feature. The gateway still
// forwards the value verbatim; the warning just tells the operator the
// upstream may ignore it.
export const computeRuleWarnings = (
  rules: ChatAliasRules,
  catalog: ControlPlaneModel | undefined,
): AliasRuleWarning[] => {
  const out: AliasRuleWarning[] = [];
  const chat = catalog?.chat;
  const reasoning = chat?.reasoning;

  if (rules.reasoning?.effort !== undefined) {
    const supported = reasoning?.effort?.supported;
    if (supported === undefined) {
      out.push({ field: 'reasoning.effort', message: 'Target does not advertise reasoning effort.' });
    } else if (!supported.includes(rules.reasoning.effort)) {
      out.push({ field: 'reasoning.effort', message: `Target advertises effort levels: ${supported.join(', ')}.` });
    }
  }

  if (rules.reasoning?.budget_tokens !== undefined) {
    const range = reasoning?.budget_tokens;
    if (range === undefined) {
      out.push({ field: 'reasoning.budget_tokens', message: 'Target does not advertise a reasoning budget.' });
    } else {
      const n = rules.reasoning.budget_tokens;
      if (range.min !== undefined && n < range.min) out.push({ field: 'reasoning.budget_tokens', message: `Below target minimum (${range.min}).` });
      if (range.max !== undefined && n > range.max) out.push({ field: 'reasoning.budget_tokens', message: `Above target maximum (${range.max}).` });
    }
  }

  if (rules.reasoning?.adaptive === true && reasoning?.adaptive !== true) {
    out.push({ field: 'reasoning.adaptive', message: 'Target does not advertise adaptive reasoning.' });
  }

  // Summary, verbosity, and serviceTier carry no catalog metadata; their
  // values forward verbatim and never warn here.

  return out;
};

// Model-level warnings for one target row. Returned as plain strings —
// the dialog already joins them with newlines for the tooltip.
//
// Two triggers:
// - Unknown target id: nothing in the catalog matches.
// - Wrong-kind target: the catalog row exists but its `kind` doesn't
//   match the alias's kind, so a /<aliasKind> request that resolves to
//   this target would fall through prefix routing's endpoint check.
export const computeModelWarnings = (
  targetModelId: string,
  catalog: ControlPlaneModel | undefined,
  aliasKind: ModelKind,
): string[] => {
  if (targetModelId === '') return [];
  if (catalog === undefined) {
    return [`"${targetModelId}" does not currently resolve to any enabled upstream binding.`];
  }
  if (catalog.kind !== aliasKind) {
    return [`"${targetModelId}" is a ${catalog.kind} model; this alias is configured for ${aliasKind}.`];
  }
  return [];
};

// Alias-level warnings: conditions that apply to the alias as a whole
// rather than to one rule field or one target row. Each entry carries a
// short tooltip-friendly message plus a discriminator tag the host
// surface (Settings card, edit dialog) can branch on for icon / copy
// choice.
//
// Today there are two triggers:
//
// - `shadow` — the alias name exactly matches a listed real-model id AND
//   no entry in `targets[].target_model_id` references that id. The
//   suppression rule keeps the seed pattern (alias names itself as its
//   own first target) quiet. Addressable-but-not-listed variant ids do
//   not trigger this — the listing surface is the relevant collision
//   space.
// - `no-target` — every configured target falls outside the addressable
//   surface, so the resolver would 404 on the alias name. The listing
//   already hides the alias from `/v1/models` in this state; the warning
//   tells the operator why the alias is invisible.
export interface AliasShadowWarning {
  type: 'shadow';
  shadowedId: string;
  shadowedDisplayName: string | null;
  message: string;
}

export interface AliasNoTargetWarning {
  type: 'no-target';
  message: string;
}

export type AliasLevelWarning = AliasShadowWarning | AliasNoTargetWarning;

const computeShadowWarning = (
  aliasName: string,
  targets: readonly { target_model_id: string }[],
  models: readonly ControlPlaneModel[] | null | undefined,
): AliasShadowWarning | null => {
  if (aliasName === '') return null;
  // Shadowing is scored against the listed surface only — an alias named
  // after an addressable-but-not-listed variant id is a deliberate
  // power-user pattern, not a collision worth warning on.
  const shadowed = (models ?? []).find(m => m.id === aliasName && m.aliasedFrom === undefined && m.unlisted !== true);
  if (!shadowed) return null;
  if (targets.some(t => t.target_model_id === aliasName)) return null;
  const displayName = shadowed.display_name ?? null;
  const shadowedDisplayName = displayName !== null && displayName !== shadowed.id ? displayName : null;
  const label = shadowedDisplayName !== null ? `${shadowed.id} (${shadowedDisplayName})` : shadowed.id;
  return {
    type: 'shadow',
    shadowedId: shadowed.id,
    shadowedDisplayName,
    message: `Alias name shadows a real model id: ${label}`,
  };
};

const computeNoTargetWarning = (
  alias: AliasView,
  models: readonly ControlPlaneModel[] | null | undefined,
): AliasNoTargetWarning | null => {
  // `useRawModelsStore` fetches with `aliases=false&include_unlisted=true`;
  // the server returns the gateway-wide surface to admin sessions, so this
  // `models` array represents every id the data-plane resolver would accept
  // on the entire gateway — not the admin's per-account view. Loading
  // state — models is null — should not fire the warning, or the dashboard
  // flashes a yellow icon on every alias during startup.
  if (models === null || models === undefined) return null;
  const addressableIds = new Set(models.filter(m => m.aliasedFrom === undefined).map(m => m.id));
  const reachable = alias.targets.some(t => addressableIds.has(t.target_model_id));
  if (reachable) return null;
  return {
    type: 'no-target',
    message: 'No target resolves to any model on this gateway.',
  };
};

// Structural view a warning consumer hands in: the persisted
// `ModelAlias` record from the Settings card and the live editor state in
// `AliasEditDialog` both project to this shape, so one helper drives both
// surfaces.
export interface AliasView {
  readonly name: string;
  readonly targets: readonly { target_model_id: string }[];
}

// Aggregate every alias-level warning that fires for this alias. Returns
// an empty list when the alias is clean; callers (Settings card row,
// edit dialog bottom card) render the icon + tooltip directly off the
// resulting array.
export const computeAliasLevelWarnings = (
  alias: AliasView,
  models: readonly ControlPlaneModel[] | null | undefined,
): AliasLevelWarning[] => {
  const out: AliasLevelWarning[] = [];
  const shadow = computeShadowWarning(alias.name, alias.targets, models);
  if (shadow !== null) out.push(shadow);
  const noTarget = computeNoTargetWarning(alias, models);
  if (noTarget !== null) out.push(noTarget);
  return out;
};
