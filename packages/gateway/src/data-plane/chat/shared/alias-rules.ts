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
import { FAST_SERVICE_TIER, isFastServiceTier, type AliasRules } from '@floway-dev/protocols/common';
import type { GeminiGenerateContentPayload } from '@floway-dev/protocols/gemini-generate-content';
import type { OpenAIChatCompletionsPayloadEx } from '@floway-dev/protocols/openai-chat-completions';
import type { OpenAIResponsesPayloadEx } from '@floway-dev/protocols/openai-responses';

const hasReasoning = (rules: AliasRules): rules is AliasRules & { reasoning: NonNullable<AliasRules['reasoning']> } =>
  rules.reasoning !== undefined;

export const applyRulesToUpstreamOpenAIChatCompletions = (body: OpenAIChatCompletionsPayloadEx, rules: AliasRules): void => {
  if (hasReasoning(rules)) {
    const { effort } = rules.reasoning;
    if (effort !== undefined) body.reasoning_effort = effort;
    // `budget_tokens`, `adaptive`, and `summary` have no native OpenAI Chat Completions
    // Completions slot; drop silently.
  }
  if (rules.verbosity !== undefined) body.verbosity = rules.verbosity;
  if (rules.serviceTier !== undefined) body.service_tier = rules.serviceTier;
};

export const applyRulesToUpstreamOpenAIResponses = (body: OpenAIResponsesPayloadEx, rules: AliasRules): void => {
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

export const applyRulesToUpstreamAnthropicMessages = (
  body: Pick<AnthropicMessagesPayload, 'output_config' | 'thinking' | 'speed' | 'service_tier'>,
  rules: AliasRules,
): void => {
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
      const priorThinking = body.thinking?.type === 'enabled'
        ? body.thinking.display === undefined ? {} : { display: body.thinking.display }
        : body.thinking;
      body.thinking = { ...priorThinking, type: 'adaptive', ...displayPart };
    } else if (budget_tokens !== undefined) {
      body.thinking = { ...body.thinking, type: 'enabled', budget_tokens, ...displayPart };
    } else if (display !== undefined && (body.thinking?.type === 'enabled' || body.thinking?.type === 'adaptive')) {
      body.thinking = { ...body.thinking, ...displayPart };
    }
  }
  // `verbosity` has no native Anthropic Messages slot; drop silently.
  if (rules.serviceTier !== undefined) {
    // Floway maps both accelerated-lane aliases to native Messages Fast Mode.
    // Clear the sibling field so tier and speed cannot specify conflicting lanes.
    if (isFastServiceTier(rules.serviceTier)) {
      body.speed = 'fast';
      delete body.service_tier;
    } else {
      body.service_tier = rules.serviceTier;
      delete body.speed;
    }
  }
};

// Gemini names its reasoning levels on `thinkingConfig.thinkingLevel` in the
// uppercase spelling its wire uses, and the inbound translator reads the same
// casing. `none` has no level spelling — Gemini disables thinking with a zero
// budget, which that translator reads back as the same preset. An
// operator-typed preset outside this list travels verbatim, since the upstream
// owns the open string.
// https://ai.google.dev/api/generate-content#ThinkingConfig
const GEMINI_GENERATE_CONTENT_THINKING_LEVELS = new Map<string, string>([
  ['minimal', 'MINIMAL'],
  ['low', 'LOW'],
  ['medium', 'MEDIUM'],
  ['high', 'HIGH'],
  ['xhigh', 'XHIGH'],
]);

export const applyRulesToUpstreamGeminiGenerateContent = (body: GeminiGenerateContentPayload, rules: AliasRules): void => {
  if (hasReasoning(rules)) {
    const { effort, budget_tokens } = rules.reasoning;
    const thinkingConfig: NonNullable<NonNullable<GeminiGenerateContentPayload['generationConfig']>['thinkingConfig']> = {
      ...body.generationConfig?.thinkingConfig,
    };
    // A level and a budget cannot be stated together, so each one replaces the
    // other rather than joining it.
    if (effort !== undefined) {
      delete thinkingConfig.thinkingBudget;
      if (effort.toLowerCase() === 'none') {
        delete thinkingConfig.thinkingLevel;
        thinkingConfig.thinkingBudget = 0;
      } else {
        thinkingConfig.thinkingLevel = GEMINI_GENERATE_CONTENT_THINKING_LEVELS.get(effort.toLowerCase()) ?? effort;
      }
    }
    if (budget_tokens !== undefined) {
      delete thinkingConfig.thinkingLevel;
      thinkingConfig.thinkingBudget = budget_tokens;
    }
    // `adaptive` and `summary` have no native Gemini generateContent slot;
    // thought presence is controlled by `includeThoughts` on the client side.
    body.generationConfig = { ...body.generationConfig, thinkingConfig };
  }
  // `verbosity` has no native Gemini generateContent slot; drop silently.
  if (rules.serviceTier !== undefined) {
    // Gemini's ServiceTier enum knows `priority` but rejects our `fast` alias
    // for the same lane with a 400, so the accelerated lane takes its spelling.
    // https://ai.google.dev/api/generate-content#ServiceTier
    body.serviceTier = isFastServiceTier(rules.serviceTier) ? FAST_SERVICE_TIER : rules.serviceTier;
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
