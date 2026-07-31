// Wire-level types for model aliases. Lives in @floway-dev/protocols because
// both the gateway control plane and the dashboard SPA need the same DTO
// shape — keeping it here means a single source of truth for snake_case
// field names and the JSON-serializable rule shapes.
//
// An alias is a named virtual model id that resolves at request time to one
// of N target model ids, optionally overlaying protocol-rule overrides
// (reasoning effort, verbosity, service tier, ...) onto the request IR.
// Resolution runs above prefix routing and never re-enters itself, which
// makes recursive aliasing impossible by construction.

import type { ModelKind } from './endpoints.ts';
import type { ChatModelInfo, PublicModelLimits } from './models.ts';

// Walk order over the alias's configured targets. Nothing is filtered out
// up front: the resolver takes the raw target list in this order, resolves
// each one against the live catalog, and flattens the results in target
// order, so a later target's candidates are the failover pool for an
// earlier one.
//
// - `first-available` — declaration order.
// - `random` — a uniform shuffle of the whole configured list, so the walk
//   distributes evenly across targets.
//
// When the walk produces no candidate at all the caller sees a 404 only if
// no target id was known to any upstream; an id that is known but of the
// wrong kind is model-unsupported, a 400.
export type AliasSelection = 'random' | 'first-available';

// Discrete reasoning-effort presets understood across upstreams. The literal
// union surfaces the canonical presets to editor autocomplete while the
// `(string & {})` arm keeps the type open — the gateway forwards rule values
// verbatim and never enum-gates them at the wire boundary, so an operator
// can pin any string the upstream understands.
export type ReasoningEffort = 'none' | 'low' | 'medium' | 'high' | 'xhigh' | (string & {});

// Reasoning-summary verbosity hint emitted on the Responses / Chat surface.
// Same open-literal shape as `ReasoningEffort`.
export type ReasoningSummary = 'auto' | 'concise' | 'detailed' | 'none' | (string & {});

// Output verbosity hint (OpenAI Responses `verbosity`). Same open-literal
// shape as `ReasoningEffort`.
export type Verbosity = 'low' | 'medium' | 'high' | (string & {});

// Per-request service tier the upstream advertises. Same open-literal shape
// as `ReasoningEffort`.
export type ServiceTier = 'default' | 'flex' | 'priority' | 'scale' | 'fast' | (string & {});

// Rule overlay applied to a chat-kind alias target. Every field is optional;
// an absent field leaves the inbound request value untouched. Rule values
// are forwarded verbatim to the upstream — the gateway does not narrow them
// against the target's advertised capability metadata.
export interface ChatAliasRules {
  reasoning?: {
    effort?: ReasoningEffort;
    budget_tokens?: number;
    adaptive?: boolean;
    summary?: ReasoningSummary;
  };
  verbosity?: Verbosity;
  serviceTier?: ServiceTier;
}

// Rule overlay payload. Today only chat-kind aliases carry rules — embedding
// image, and rerank targets pass `{}`, which already satisfies `ChatAliasRules`
// because every field is optional. The type is a single alias rather than a
// union so consumers can read `rules.reasoning?.effort` directly without an
// unchecked cast.
export type AliasRules = ChatAliasRules;

// One target row inside an alias's `targets` list. Order is meaningful for
// `first-available` selection and preserved (but ignored) for `random`.
export interface AliasTarget {
  target_model_id: string;
  rules: AliasRules;
}

// Operator-set override for the alias's announced /v1/models payload —
// the `limits` + `chat.*` block the listing surfaces to clients. Sparse:
// any top-level sub-block (`limits` / `chat`) the operator leaves unset
// falls back wholesale to the rule-aware intersection across the alias's
// available targets. Fallback is at the sub-block boundary, not per-leaf:
// posting `{ limits: { max_output_tokens: 8192 } }` replaces `limits`
// entirely, so other limit keys disappear from the announced metadata
// unless the override re-states them. (The dashboard hides this by
// seeding the buffer from the full computed snapshot at the moment the
// "Enable override" switch flips on.) `kind`, the supported endpoint set,
// and `pricing` are not part of this payload: `kind` follows from the alias
// row, endpoints from the target union, and `pricing` is announced only when
// the alias has exactly one available target, because rates across several
// targets have no meaningful merge.
export interface AnnouncedMetadata {
  limits?: PublicModelLimits;
  chat?: ChatModelInfo;
}

// Wire DTO returned by `/api/aliases`. snake_case to match the rest of the
// control plane; `display_name === null` means "derive at render time";
// `announced_metadata === null` means "compute the announced payload from
// targets + rules at listing time". `kind` picks the endpoint family the
// alias serves; rules are only meaningful when the kind admits them (today
// that is `chat`).
//
// `id` is the row's opaque, server-issued handle — the only thing the
// control-plane routes address an alias by. `name` is the public model id
// clients send on the data plane, and an operator renames it freely; it
// carries whatever characters a model id carries, `/` included, so it is
// unfit for a URL path segment.
export interface ModelAlias {
  id: string;
  name: string;
  kind: ModelKind;
  selection: AliasSelection;
  display_name: string | null;
  visible_in_models_list: boolean;
  targets: AliasTarget[];
  announced_metadata: AnnouncedMetadata | null;
  sort_order: number;
  created_at: string;
  updated_at: string;
}

// One badge per configured rule field, in the canonical order. `field`
// names the specific rule slot and `value` preserves its typed coordinate for
// localized renderers; `label` remains the canonical English inline form.
export const ALIAS_RULE_BADGE_FIELDS = [
  'reasoning.effort',
  'reasoning.budget_tokens',
  'reasoning.adaptive',
  'reasoning.summary',
  'verbosity',
  'serviceTier',
] as const;

export type AliasRuleBadgeField = typeof ALIAS_RULE_BADGE_FIELDS[number];

export interface AliasRuleBadge {
  label: string;
  field: AliasRuleBadgeField;
  value: string | number | boolean;
}

// Inline-prose parts for an alias's rules, in the canonical field order. The
// same builder backs `formatAliasRulesInline` (joins labels with `, ` for a
// single summary string) and `formatAliasRuleBadges` (emits badge rows).
// Keeping every surface — inline copy, badge sequence, parenthesized
// suffix in the derived display name — on a single ordered walk means an
// operator who configures `effort + verbosity` sees them in the same order
// whether the dashboard renders badges or a comma-joined caption.
const aliasRuleParts = (rules: AliasRules): AliasRuleBadge[] => {
  const parts: AliasRuleBadge[] = [];
  if (rules.reasoning?.effort !== undefined) parts.push({ field: 'reasoning.effort', label: `${rules.reasoning.effort} effort`, value: rules.reasoning.effort });
  if (rules.reasoning?.budget_tokens !== undefined) parts.push({ field: 'reasoning.budget_tokens', label: `${rules.reasoning.budget_tokens}tok budget`, value: rules.reasoning.budget_tokens });
  if (rules.reasoning?.adaptive === true) parts.push({ field: 'reasoning.adaptive', label: 'adaptive', value: true });
  else if (rules.reasoning?.adaptive === false) parts.push({ field: 'reasoning.adaptive', label: 'non-adaptive', value: false });
  if (rules.reasoning?.summary !== undefined) parts.push({ field: 'reasoning.summary', label: `summary: ${rules.reasoning.summary}`, value: rules.reasoning.summary });
  if (rules.verbosity !== undefined) parts.push({ field: 'verbosity', label: `${rules.verbosity} verbosity`, value: rules.verbosity });
  if (rules.serviceTier !== undefined) parts.push({ field: 'serviceTier', label: `${rules.serviceTier} tier`, value: rules.serviceTier });
  return parts;
};

export const formatAliasRuleBadges = (rules: AliasRules): AliasRuleBadge[] => aliasRuleParts(rules);

// Comma-joined version of the same ordered parts. Empty string when no
// rule applies — callers should drop the line entirely rather than render
// blank.
export const formatAliasRulesInline = (rules: AliasRules): string =>
  aliasRuleParts(rules).map(p => p.label).join(', ');

// Derived display name for a single-target alias whose operator did not set
// `display_name`. Bare `target_model_id` when no rule is configured; with
// rules, the inline summary is parenthesized. Multi-target aliases skip
// this helper entirely — the listing falls back to the alias's own name
// because no single target represents the alias.
export const composeAliasDisplayName = (targetModelId: string, rules: AliasRules): string => {
  const inline = formatAliasRulesInline(rules);
  return inline === '' ? targetModelId : `${targetModelId} (${inline})`;
};
