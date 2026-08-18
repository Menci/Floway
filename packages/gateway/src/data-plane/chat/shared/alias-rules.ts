// Post-translate rule overlay. The alias resolver tags each alias-origin
// candidate with `.rules`; each terminal wire call reads them off the
// dispatching candidate and puts them on the target IR's NATIVE slot before
// dispatching. Rules that a target protocol cannot express are silently
// dropped — the wire has nowhere to put them.
//
// Structuring the overlay this way keeps every translate pair pure
// native↔native and eliminates the fan-out of Floway-extension fields onto
// each source IR.
//
// Each overlay returns the payload it produced rather than writing into the one it was handed.
// What it is handed descends from a record, and a record's values are frozen — an overlay that
// wrote in place would work only for as long as its caller happened to have rebuilt the level
// it writes to, which is the shape of failure that reached a client as a 502 once already.

import type { AnthropicMessagesPayload, AnthropicMessagesThinkingDisplay } from '@floway-dev/protocols/anthropic-messages';
import type { AliasRules } from '@floway-dev/protocols/common';
import type { OpenAIChatCompletionsPayload } from '@floway-dev/protocols/openai-chat-completions';
import type { OpenAIResponsesPayload } from '@floway-dev/protocols/openai-responses';

type Reasoning = NonNullable<AliasRules['reasoning']>;

const reasoningOf = (rules: AliasRules): Reasoning => rules.reasoning ?? {};

export const applyRulesToUpstreamOpenAIChatCompletions = <T extends OpenAIChatCompletionsPayload>(body: T, rules: AliasRules): T => {
  // `budget_tokens`, `adaptive`, and `summary` have no native OpenAI Chat Completions slot;
  // drop silently.
  const { effort } = reasoningOf(rules);
  return {
    ...body,
    ...(effort === undefined ? {} : { reasoning_effort: effort }),
    ...(rules.verbosity === undefined ? {} : { verbosity: rules.verbosity }),
    ...(rules.serviceTier === undefined ? {} : { service_tier: rules.serviceTier }),
  } as T;
};

export const applyRulesToUpstreamOpenAIResponses = <T extends OpenAIResponsesPayload>(body: T, rules: AliasRules): T => {
  // `budget_tokens` and `adaptive` have no native OpenAI Responses slot; drop silently.
  const { effort, summary } = reasoningOf(rules);
  return {
    ...body,
    ...(effort === undefined && summary === undefined ? {} : {
      reasoning: {
        ...body.reasoning,
        ...(effort === undefined ? {} : { effort }),
        ...(summary === undefined ? {} : { summary }),
      },
    }),
    ...(rules.verbosity === undefined ? {} : { text: { ...body.text, verbosity: rules.verbosity } }),
    ...(rules.serviceTier === undefined ? {} : { service_tier: rules.serviceTier }),
  } as T;
};

export const applyRulesToUpstreamAnthropicMessages = <T extends AnthropicMessagesPayload>(body: T, rules: AliasRules): T => {
  // `verbosity` has no native Anthropic Messages slot; drop silently.
  const reasoning = reasoningOf(rules);
  const thinking = anthropicMessagesThinking(body.thinking, reasoning);
  const reasoned = {
    ...body,
    // Anthropic stores explicit effort in `output_config.effort`; budget /
    // adaptive ride on `thinking.*`. Splitting them so both can be set in
    // the same overlay (effort fixed + budget pinned, e.g.) without one
    // erasing the other.
    ...(reasoning.effort === undefined ? {} : { output_config: { ...body.output_config, effort: reasoning.effort } }),
    ...(thinking === undefined ? {} : { thinking }),
  } as T;
  if (rules.serviceTier === undefined) return reasoned;

  // The cross-protocol bridge in translate maps `speed: 'fast'` ↔
  // `service_tier: 'fast'`; on a native Anthropic Messages target the alias rule
  // `serviceTier: 'fast'` lands on `speed` so the upstream sees Fast Mode
  // through its native field. Other tier values pass through on
  // `service_tier` since Anthropic Messages's native enum (`auto`/`standard_only`)
  // doesn't model them. Whichever branch we take, the sibling field is gone
  // so the upstream never sees two tiers in conflict.
  const { speed: _speed, service_tier: _serviceTier, ...tierless } = reasoned;
  return (rules.serviceTier === 'fast'
    ? { ...tierless, speed: 'fast' }
    : { ...tierless, service_tier: rules.serviceTier }) as T;
};

/** The `thinking` block an overlay asks for, or `undefined` where it asks for none. */
const anthropicMessagesThinking = (
  prior: AnthropicMessagesPayload['thinking'],
  reasoning: Reasoning,
): AnthropicMessagesPayload['thinking'] | undefined => {
  const { budget_tokens, adaptive, summary } = reasoning;
  const display = summary === undefined ? undefined : mapSummaryToAnthropicMessagesDisplay(summary);
  const displayPart = display === undefined ? {} : { display };

  if (adaptive === true) {
    // Adaptive auto-determines the budget; a client-set `budget_tokens` goes, so the alias
    // rule's mode is not accompanied by a sibling budget the operator didn't ask for.
    const { budget_tokens: _drop, ...priorThinking } = prior ?? {};
    return { ...priorThinking, type: 'adaptive', ...displayPart };
  }
  if (budget_tokens !== undefined) return { ...prior, type: 'enabled', budget_tokens, ...displayPart };
  // Anthropic discards `thinking.display` unless a mode is set; default
  // to the enabled variant so the summary hint reaches the wire.
  if (display !== undefined) return { ...prior, type: 'enabled', ...displayPart };
  return undefined;
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
