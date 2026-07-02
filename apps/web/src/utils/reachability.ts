// Frontend reachability check: given a `ControlPlaneModel` row and the
// catalog it lives in, decide whether the caller can route to it under an
// upstream-id cap. The server always returns the gateway-wide catalog for
// admin sessions (and the caller-scoped catalog for non-admin); the
// dashboard's Models page + playground then filter client-side by the
// effective cap of the selected api key (which itself inherits from the
// owner user's `upstreamIds` when the key has no whitelist of its own).
//
// `cap === null` means "no restriction" (every upstream is reachable).
// `cap` is a freshly-resolved array of upstream ids the caller is allowed
// to route to right now.

import type { ControlPlaneModel } from '../api/types.ts';

// Resolve the effective per-request cap. Mirrors the gateway's
// `effectiveUpstreamIdsFromContext` (packages/gateway/src/middleware/auth.ts):
// both null = unrestricted; one null = the other; both set = intersection.
// A key created against a broader user cap keeps its original id list even
// after admin narrows the user cap, so the intersection is load-bearing —
// the ??-fallback shape used to happen to agree because the api-keys route
// enforces `key ⊆ user` at creation, but the two drift the moment the user
// cap shrinks post-hoc.
export const effectiveUpstreamCap = (
  keyUpstreamIds: readonly string[] | null,
  userUpstreamIds: readonly string[] | null,
): readonly string[] | null => {
  if (keyUpstreamIds === null && userUpstreamIds === null) return null;
  if (keyUpstreamIds === null) return userUpstreamIds;
  if (userUpstreamIds === null) return keyUpstreamIds;
  const userSet = new Set(userUpstreamIds);
  return keyUpstreamIds.filter(id => userSet.has(id));
};

// True when any of the model's upstream bindings is in the cap (or the
// cap is unrestricted). For an alias row this is always false — the
// alias's bindings list is empty and reachability runs through its
// targets instead.
const realModelReachable = (
  model: ControlPlaneModel,
  cap: readonly string[] | null,
): boolean => {
  if (cap === null) return true;
  return model.upstreams.some(binding => cap.includes(binding.id));
};

// Returns whether the alias has at least one configured target whose
// resolved real model is reachable under the cap. A target whose
// `target_model_id` does not appear in the catalog at all (e.g. operator
// typo, model removed) is treated as unreachable. Addressable-but-not-
// listed entries (Copilot variant ids, prefix alternates) carry their
// canonical real model's `upstreams`, so they count as reachable through
// the same predicate.
export const reachableTargets = (
  alias: ControlPlaneModel,
  catalog: readonly ControlPlaneModel[],
  cap: readonly string[] | null,
): readonly ControlPlaneModel[] => {
  if (alias.aliasedFrom === undefined) return [];
  const out: ControlPlaneModel[] = [];
  for (const t of alias.aliasedFrom.targets) {
    const target = catalog.find(row => row.id === t.target_model_id && row.aliasedFrom === undefined);
    if (target && realModelReachable(target, cap)) out.push(target);
  }
  return out;
};

// True for a real model with at least one in-cap binding; true for an
// alias with at least one reachable target. Hides a row from a listing
// when the caller would 404 on it.
export const isReachableUnderCap = (
  model: ControlPlaneModel,
  catalog: readonly ControlPlaneModel[],
  cap: readonly string[] | null,
): boolean => {
  if (model.aliasedFrom === undefined) return realModelReachable(model, cap);
  return reachableTargets(model, catalog, cap).length > 0;
};
