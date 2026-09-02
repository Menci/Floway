// Post-translate rule overlay. The alias resolver tags each alias-origin
// candidate with `.rules`; each terminal wire call reads them off the
// dispatching candidate and writes onto the target IR's NATIVE slot before
// dispatching. Rules that a target protocol cannot express are silently
// dropped — the wire has nowhere to put them.
//
// Structuring the overlay this way keeps every translate pair pure
// native↔native and eliminates the fan-out of Floway-extension fields onto
// each source IR.

import type { AnthropicMessagesPayload, AnthropicMessagesThinkingDisplay } from '@floway-dev/protocols/anthropic-messages';
import type { AliasRules } from '@floway-dev/protocols/common';
import { isFastServiceTier } from '@floway-dev/protocols/common';
import type { OpenAIChatCompletionsPayload } from '@floway-dev/protocols/openai-chat-completions';
import type { OpenAIResponsesPayload } from '@floway-dev/protocols/openai-responses';

const hasReasoning = (rules: AliasRules): rules is AliasRules & { reasoning: NonNullable<AliasRules['reasoning']> } =>
  rules.reasoning !== undefined;

export const applyRulesToUpstreamOpenAIChatCompletions = (body: OpenAIChatCompletionsPayload, rules: AliasRules): void => {
  if (hasReasoning(rules)) {
    const { effort } = rules.reasoning;
    if (effort !== undefined) body.reasoning_effort = effort;
    // `budget_tokens`, `adaptive`, and `summary` have no native OpenAI Chat Completions
    // Completions slot; drop silently.
  }
  if (rules.verbosity !== undefined) body.verbosity = rules.verbosity;
  if (rules.serviceTier !== undefined) body.service_tier = rules.serviceTier;
};

export const applyRulesToUpstreamOpenAIResponses = (body: OpenAIResponsesPayload, rules: AliasRules): void => {
  if (hasReasoning(rules)) {
    const { effort, summary } = rules.reasoning;
    if (effort !== undefined || summary !== undefined) {
      const existing = body.reasoning ?? {};
      body.reasoning = {
        ...existing,
        ...(effort !== undefined ? { effort } : {}),
        ...(summary !== undefined ? { summary } : {}),
      };
    }
    // `budget_tokens` and `adaptive` have no native OpenAI Responses slot; drop
    // silently.
  }
  if (rules.verbosity !== undefined) {
    body.text = { ...body.text, verbosity: rules.verbosity };
  }
  if (rules.serviceTier !== undefined) body.service_tier = rules.serviceTier;
};

export const applyRulesToUpstreamAnthropicMessages = (body: AnthropicMessagesPayload, rules: AliasRules): void => {
  if (hasReasoning(rules)) {
    const { effort, budget_tokens, adaptive, summary } = rules.reasoning;
    // Anthropic stores explicit effort in `output_config.effort`; budget /
    // adaptive ride on `thinking.*`. Splitting them so both can be set in
    // the same overlay (effort fixed + budget pinned, e.g.) without one
    // erasing the other.
    if (effort !== undefined) {
      body.output_config = { ...body.output_config, effort };
    }
    const display = summary !== undefined ? mapSummaryToAnthropicMessagesDisplay(summary) : undefined;
    const displayPart = display !== undefined ? { display } : {};
    if (adaptive === true) {
      // Adaptive auto-determines the budget; strip any client-set
      // `budget_tokens` so the alias rule's mode isn't accompanied by a
      // sibling budget the operator didn't ask for.
      const { budget_tokens: _drop, ...priorThinking } = body.thinking ?? {};
      body.thinking = { ...priorThinking, type: 'adaptive', ...displayPart };
    } else if (budget_tokens !== undefined) {
      body.thinking = { ...body.thinking, type: 'enabled', budget_tokens, ...displayPart };
    } else if (display !== undefined) {
      // Anthropic discards `thinking.display` unless a mode is set; default
      // to the enabled variant so the summary hint reaches the wire.
      body.thinking = { ...body.thinking, type: 'enabled', ...displayPart };
    }
  }
  // `verbosity` has no native Anthropic Messages slot; drop silently.
  if (rules.serviceTier !== undefined) {
    // The cross-protocol bridge in translate maps `speed: 'fast'` ↔ the
    // OpenAI accelerated lane; on a native Anthropic Messages target an alias
    // rule naming that lane lands on `speed` so the upstream sees Fast Mode
    // through its native field. Both OpenAI spellings count, since OpenAI
    // itself accepts `priority` and `fast` interchangeably. Other tier values
    // pass through on `service_tier` since Anthropic Messages's native request
    // enum (`auto`/`standard_only`) doesn't model them. Whichever branch we
    // take, clear the sibling field so the upstream never sees two tiers in
    // conflict.
    if (isFastServiceTier(rules.serviceTier)) {
      body.speed = 'fast';
      delete body.service_tier;
    } else {
      body.service_tier = rules.serviceTier;
      delete body.speed;
    }
  }
};

// Collapse OpenAI-style summary presets onto Anthropic's structured
// `thinking.display` enumeration: `concise`/`detailed` both surface a
// redacted summary and collapse to `summarized`; `omitted` is the
// canonical hide-everything spelling; `auto` returns undefined so
// Anthropic's account default takes over. Operator-typed values that match
// neither vocabulary pass through verbatim — Anthropic rejects unknown
// values at the wire, which is the explicit-failure path.
const mapSummaryToAnthropicMessagesDisplay = (summary: string): AnthropicMessagesThinkingDisplay | undefined => {
  switch (summary) {
  case 'concise':
  case 'detailed':
    return 'summarized';
  case 'omitted':
    return 'omitted';
  case 'auto':
    return undefined;
  default:
    // Anthropic rejects unknown enum values at the wire, so passing an
    // operator-typed value verbatim is the explicit-failure path.
    return summary as AnthropicMessagesThinkingDisplay;
  }
};
