// Frontend mirror of the backend `synthesizeOne`'s rule-aware
// intersection. The dashboard renders the read-only view of an
// alias's announced metadata when no operator override is set; the
// edit dialog also seeds the editor with this exact payload when
// the operator flips the override switch on, so the editor starts
// from the same baseline the wire surface would have published.
//
// Mirrors packages/gateway/src/data-plane/shared/listing/alias.ts.
// Keeping a local copy avoids a server round-trip per dialog open,
// at the cost of a duplicated computation that we keep in sync by
// hand. The backend stays authoritative — what `/v1/models` reports
// is what the gateway computes there, not what this helper emits.

import type { AliasTarget, AnnouncedMetadata, ChatAliasRules, ChatModelInfo, ControlPlaneModel, PublicModelLimits } from '../../api/types.ts';

const chatRules = (target: AliasTarget): ChatAliasRules => target.rules;

const intersectArrays = <T>(arrays: readonly (readonly T[])[]): T[] => {
  if (arrays.length === 0) return [];
  const [head, ...tail] = arrays;
  return head.filter(value => tail.every(other => other.includes(value)));
};

// Apply the rule-driven downgrade: a target with a pinned rule
// reports the corresponding catalog sub-field as unsupported for
// the purposes of intersection.
const effectiveChatForIntersection = (chat: ChatModelInfo | undefined, target: AliasTarget): ChatModelInfo | undefined => {
  if (chat === undefined) return undefined;
  const rules = chatRules(target);
  const ruleReasoning = rules.reasoning;
  if (ruleReasoning === undefined) return chat;
  if (chat.reasoning === undefined) return chat;

  const reasoning: NonNullable<ChatModelInfo['reasoning']> = { ...chat.reasoning };
  if (ruleReasoning.effort !== undefined) delete reasoning.effort;
  if (ruleReasoning.budget_tokens !== undefined) delete reasoning.budget_tokens;
  if (ruleReasoning.adaptive === true) delete reasoning.adaptive;

  return { ...chat, reasoning };
};

const intersectChat = (chats: readonly ChatModelInfo[]): ChatModelInfo | undefined => {
  const result: ChatModelInfo = {};

  const modalityChats = chats.filter(c => c.modalities !== undefined);
  if (modalityChats.length === chats.length) {
    const input = intersectArrays(modalityChats.map(c => c.modalities!.input));
    const output = intersectArrays(modalityChats.map(c => c.modalities!.output));
    // Both halves must survive — `{ input: ['text'], output: [] }`
    // would advertise a chat model that consumes input but produces
    // nothing. Mirrors the gateway-side rule.
    if (input.length > 0 && output.length > 0) result.modalities = { input, output };
  }

  const reasoningChats = chats.filter(c => c.reasoning !== undefined);
  if (reasoningChats.length === chats.length) {
    const reasoning: NonNullable<ChatModelInfo['reasoning']> = {};

    const effortChats = reasoningChats.filter(c => c.reasoning!.effort !== undefined);
    if (effortChats.length === reasoningChats.length) {
      const supported = intersectArrays(effortChats.map(c => c.reasoning!.effort!.supported));
      const defaults = new Set(effortChats.map(c => c.reasoning!.effort!.default));
      if (supported.length > 0) {
        const agreedDefault = defaults.size === 1 ? [...defaults][0] : undefined;
        reasoning.effort = agreedDefault !== undefined && supported.includes(agreedDefault)
          ? { supported, default: agreedDefault }
          : { supported, default: supported[0]! };
      }
    }

    const budgetChats = reasoningChats.filter(c => c.reasoning!.budget_tokens !== undefined);
    if (budgetChats.length === reasoningChats.length) {
      const mins = budgetChats.map(c => c.reasoning!.budget_tokens!.min).filter((v): v is number => v !== undefined);
      const maxes = budgetChats.map(c => c.reasoning!.budget_tokens!.max).filter((v): v is number => v !== undefined);
      // Both min and max must be all-declared — a half-declared block
      // would claim a capability some target does not report. Mirrors the
      // gateway-side rule.
      if (mins.length === budgetChats.length && maxes.length === budgetChats.length) {
        const min = Math.max(...mins);
        const max = Math.min(...maxes);
        if (min <= max) reasoning.budget_tokens = { min, max };
      }
    }

    const adaptiveAgreed = new Set(reasoningChats.map(c => c.reasoning!.adaptive));
    if (adaptiveAgreed.size === 1) {
      const value = [...adaptiveAgreed][0];
      if (value !== undefined) reasoning.adaptive = value;
    }
    const mandatoryAgreed = new Set(reasoningChats.map(c => c.reasoning!.mandatory));
    if (mandatoryAgreed.size === 1) {
      const value = [...mandatoryAgreed][0];
      if (value !== undefined) reasoning.mandatory = value;
    }

    if (Object.keys(reasoning).length > 0) result.reasoning = reasoning;
  }

  return Object.keys(result).length > 0 ? result : undefined;
};

const LIMIT_KEYS = ['max_context_window_tokens', 'max_prompt_tokens', 'max_output_tokens'] as const;

const intersectLimits = (limitsList: readonly PublicModelLimits[]): PublicModelLimits => {
  if (limitsList.length === 0) return {};
  const result: PublicModelLimits = {};
  for (const key of LIMIT_KEYS) {
    const values = limitsList.map(l => l[key]).filter((v): v is number => v !== undefined);
    if (values.length === limitsList.length) result[key] = Math.min(...values);
  }
  return result;
};

// Returns the rule-aware intersection across the targets that the live
// catalog currently serves under the alias's kind. The returned shape
// matches AnnouncedMetadata; an empty payload (no targets matched)
// returns `{}` so callers can still render a skeleton.
export const computeAnnouncedMetadata = (
  targets: readonly AliasTarget[],
  kind: 'chat' | 'embedding' | 'image',
  models: readonly ControlPlaneModel[] | null | undefined,
): AnnouncedMetadata => {
  const realById = new Map((models ?? []).filter(m => m.aliasedFrom === undefined).map(m => [m.id, m] as const));
  const available = targets
    .map(target => ({ target, real: realById.get(target.target_model_id) }))
    .filter((entry): entry is { target: AliasTarget; real: ControlPlaneModel } => entry.real?.kind === kind);

  if (available.length === 0) return {};

  const limitsList = available.map(({ real }) => real.limits);
  const limits = intersectLimits(limitsList);

  const effectiveChats = available
    .map(({ target, real }) => effectiveChatForIntersection(real.chat, target))
    .filter((c): c is ChatModelInfo => c !== undefined);
  const chat = effectiveChats.length === available.length
    ? intersectChat(effectiveChats)
    : undefined;

  const out: AnnouncedMetadata = {};
  if (Object.keys(limits).length > 0) out.limits = limits;
  if (chat !== undefined) out.chat = chat;
  return out;
};
