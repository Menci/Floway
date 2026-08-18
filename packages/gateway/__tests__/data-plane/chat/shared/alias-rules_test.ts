// Behavioral coverage for the target-side rule overlay. Each target's
// apply helper is exercised against an inbound payload IR; alias rules
// are authoritative — an existing IR field is OVERWRITTEN by a matching
// rule — and rules the target IR cannot express are silently dropped
// (there's no wire slot to put them on).
//
// Every helper produces a payload rather than writing into the one it was handed, which the
// three frozen-input cases pin: what an overlay is handed at the dial is a record's value.

import { test } from 'vitest';

import { applyRulesToUpstreamOpenAIChatCompletions, applyRulesToUpstreamAnthropicMessages, applyRulesToUpstreamOpenAIResponses } from '../../../../src/data-plane/chat/shared/alias-rules.ts';
import type { AnthropicMessagesPayload } from '@floway-dev/protocols/anthropic-messages';
import type { OpenAIChatCompletionsPayload } from '@floway-dev/protocols/openai-chat-completions';
import type { OpenAIResponsesPayload } from '@floway-dev/protocols/openai-responses';
import { assertEquals } from '@floway-dev/test-utils';

const ccPayload = (overrides: Partial<OpenAIChatCompletionsPayload> = {}): OpenAIChatCompletionsPayload => ({
  model: 'gpt-5.4',
  messages: [{ role: 'user', content: 'hi' }],
  ...overrides,
});

const resPayload = (overrides: Partial<OpenAIResponsesPayload> = {}): OpenAIResponsesPayload => ({
  model: 'gpt-5.4',
  input: 'hi',
  ...overrides,
});

const msgPayload = (overrides: Partial<AnthropicMessagesPayload> = {}): AnthropicMessagesPayload => ({
  model: 'claude-opus-4-7',
  max_tokens: 32,
  messages: [{ role: 'user', content: 'hi' }],
  ...overrides,
});

// ── OpenAI Chat Completions target ──

test('openai-chat-completions: empty rules leave the payload unchanged', () => {
  const body = ccPayload({ reasoning_effort: 'high', verbosity: 'low', service_tier: 'priority' });
  const applied = applyRulesToUpstreamOpenAIChatCompletions(body, {});
  assertEquals(applied.reasoning_effort, 'high');
  assertEquals(applied.verbosity, 'low');
  assertEquals(applied.service_tier, 'priority');
});

test('openai-chat-completions: rules stamp every supported native field onto the IR', () => {
  const body = ccPayload();
  const applied = applyRulesToUpstreamOpenAIChatCompletions(body, {
    reasoning: { effort: 'high' },
    verbosity: 'low',
    serviceTier: 'priority',
  });
  assertEquals(applied.reasoning_effort, 'high');
  assertEquals(applied.verbosity, 'low');
  assertEquals(applied.service_tier, 'priority');
});

test('openai-chat-completions: budget_tokens / adaptive / summary have no native slot — silently dropped', () => {
  const body = ccPayload();
  const applied = applyRulesToUpstreamOpenAIChatCompletions(body, {
    reasoning: { budget_tokens: 1024, adaptive: true, summary: 'detailed' },
  });
  assertEquals(applied.reasoning_effort, undefined);
  // Nothing surfaces on the CC IR because none of those rules map to
  // OpenAI Chat Completions' native fields.
  assertEquals('thinking_budget' in applied, false);
  assertEquals('adaptive_thinking' in applied, false);
  assertEquals('reasoning_summary' in applied, false);
});

test('openai-chat-completions: alias rules overwrite existing IR fields', () => {
  const body = ccPayload({ reasoning_effort: 'low', verbosity: 'high', service_tier: 'default' });
  const applied = applyRulesToUpstreamOpenAIChatCompletions(body, {
    reasoning: { effort: 'xhigh' },
    verbosity: 'low',
    serviceTier: 'priority',
  });
  assertEquals(applied.reasoning_effort, 'xhigh');
  assertEquals(applied.verbosity, 'low');
  assertEquals(applied.service_tier, 'priority');
});

// ── OpenAI Responses target ──

test('openai-responses: empty rules leave the payload unchanged', () => {
  const body = resPayload({ reasoning: { effort: 'high' }, text: { verbosity: 'low' }, service_tier: 'priority' });
  const applied = applyRulesToUpstreamOpenAIResponses(body, {});
  assertEquals(applied.reasoning?.effort, 'high');
  assertEquals(applied.text?.verbosity, 'low');
  assertEquals(applied.service_tier, 'priority');
});

test('openai-responses: rules stamp every supported native field onto the IR', () => {
  const body = resPayload();
  const applied = applyRulesToUpstreamOpenAIResponses(body, {
    reasoning: { effort: 'high', summary: 'concise' },
    verbosity: 'medium',
    serviceTier: 'flex',
  });
  assertEquals(applied.reasoning?.effort, 'high');
  assertEquals(applied.reasoning?.summary, 'concise');
  assertEquals(applied.text?.verbosity, 'medium');
  assertEquals(applied.service_tier, 'flex');
});

test('openai-responses: budget_tokens / adaptive have no native slot — silently dropped', () => {
  const body = resPayload();
  const applied = applyRulesToUpstreamOpenAIResponses(body, {
    reasoning: { budget_tokens: 1024, adaptive: true },
  });
  assertEquals(applied.reasoning, undefined);
  assertEquals('thinking_budget' in applied, false);
  assertEquals('adaptive_thinking' in applied, false);
});

test('openai-responses: alias rules overwrite owned fields while preserving reasoning.context', () => {
  const body = resPayload({
    reasoning: { effort: 'low', summary: 'auto', context: 'future_mode' },
    service_tier: 'default',
    text: { verbosity: 'high' },
  });
  const applied = applyRulesToUpstreamOpenAIResponses(body, {
    reasoning: { effort: 'xhigh', summary: 'detailed' },
    verbosity: 'low',
    serviceTier: 'priority',
  });
  assertEquals(applied.reasoning, { effort: 'xhigh', summary: 'detailed', context: 'future_mode' });
  assertEquals(applied.text?.verbosity, 'low');
  assertEquals(applied.service_tier, 'priority');
});

// ── Anthropic Messages target ──

test('anthropic-messages: empty rules leave the payload unchanged', () => {
  const body = msgPayload({ output_config: { effort: 'high' }, thinking: { type: 'enabled', budget_tokens: 512 }, speed: 'fast' });
  const applied = applyRulesToUpstreamAnthropicMessages(body, {});
  assertEquals(applied.output_config?.effort, 'high');
  assertEquals(applied.thinking?.budget_tokens, 512);
  assertEquals(applied.speed, 'fast');
});

test('anthropic-messages: effort lands on output_config, budget+adaptive land on thinking', () => {
  const body = msgPayload();
  const applied = applyRulesToUpstreamAnthropicMessages(body, {
    reasoning: { effort: 'high', budget_tokens: 2048 },
  });
  assertEquals(applied.output_config?.effort, 'high');
  assertEquals(applied.thinking?.type, 'enabled');
  assertEquals(applied.thinking?.budget_tokens, 2048);
});

test('anthropic-messages: verbosity has no Anthropic-shaped slot — silently dropped', () => {
  const body = msgPayload();
  const applied = applyRulesToUpstreamAnthropicMessages(body, { verbosity: 'low' });
  assertEquals('verbosity' in applied, false);
});

test('anthropic-messages: summary=concise|detailed collapses onto thinking.display=summarized (enables thinking)', () => {
  const body = msgPayload();
  const applied = applyRulesToUpstreamAnthropicMessages(body, { reasoning: { summary: 'concise' } });
  assertEquals(applied.thinking?.type, 'enabled');
  assertEquals(applied.thinking?.display, 'summarized');
});

test('anthropic-messages: summary=omitted collapses onto thinking.display=omitted', () => {
  const body = msgPayload();
  const applied = applyRulesToUpstreamAnthropicMessages(body, { reasoning: { summary: 'omitted' } });
  assertEquals(applied.thinking?.display, 'omitted');
});

test('anthropic-messages: summary=auto is a no-op (Anthropic default takes over)', () => {
  const body = msgPayload();
  const applied = applyRulesToUpstreamAnthropicMessages(body, { reasoning: { summary: 'auto' } });
  assertEquals(applied.thinking, undefined);
});

test('anthropic-messages: adaptive=true sets thinking.type=adaptive and ignores budget_tokens', () => {
  const body = msgPayload();
  const applied = applyRulesToUpstreamAnthropicMessages(body, { reasoning: { adaptive: true, budget_tokens: 4096 } });
  assertEquals(applied.thinking?.type, 'adaptive');
});

test('anthropic-messages: adaptive=true strips a client-set budget_tokens from body.thinking', () => {
  const body = msgPayload();
  body.thinking = { type: 'enabled', budget_tokens: 5000 };
  const applied = applyRulesToUpstreamAnthropicMessages(body, { reasoning: { adaptive: true } });
  assertEquals(applied.thinking?.type, 'adaptive');
  // The prior client budget must not leak into the adaptive block — adaptive
  // auto-determines the budget and a sibling budget_tokens violates the
  // rules-are-authoritative contract.
  assertEquals((applied.thinking as { budget_tokens?: number }).budget_tokens, undefined);
});

test('anthropic-messages: serviceTier=fast maps to speed=fast (cross-protocol bridge)', () => {
  const body = msgPayload();
  const applied = applyRulesToUpstreamAnthropicMessages(body, { serviceTier: 'fast' });
  assertEquals(applied.speed, 'fast');
  assertEquals(applied.service_tier, undefined);
});

test('anthropic-messages: non-fast serviceTier lands on service_tier directly', () => {
  const body = msgPayload();
  const applied = applyRulesToUpstreamAnthropicMessages(body, { serviceTier: 'priority' });
  assertEquals(applied.service_tier, 'priority');
  assertEquals(applied.speed, undefined);
});

test('anthropic-messages: serviceTier=fast clears a pre-existing body.service_tier on the same payload', () => {
  // Upstream must never see both `speed` and `service_tier` set on the
  // same request — Anthropic treats them as alternates and the wire
  // semantics for a conflict are undefined. The overlay clears the
  // sibling field whichever branch it takes.
  const body = msgPayload({ service_tier: 'priority' });
  const applied = applyRulesToUpstreamAnthropicMessages(body, { serviceTier: 'fast' });
  assertEquals(applied.speed, 'fast');
  assertEquals(applied.service_tier, undefined);
});

test('anthropic-messages: non-fast serviceTier clears a pre-existing body.speed on the same payload', () => {
  const body = msgPayload({ speed: 'fast' });
  const applied = applyRulesToUpstreamAnthropicMessages(body, { serviceTier: 'priority' });
  assertEquals(applied.service_tier, 'priority');
  assertEquals(applied.speed, undefined);
});

test('anthropic-messages: alias rules overwrite existing thinking + output_config fields', () => {
  const body = msgPayload({ output_config: { effort: 'low' }, thinking: { type: 'enabled', budget_tokens: 100 } });
  const applied = applyRulesToUpstreamAnthropicMessages(body, { reasoning: { effort: 'xhigh', budget_tokens: 9999 } });
  assertEquals(applied.output_config?.effort, 'xhigh');
  assertEquals(applied.thinking?.budget_tokens, 9999);
});

// ── The frozen payload every overlay is actually handed ──
//
// At the dial the payload descends from a record, so the object an overlay is handed is frozen
// and every rule it could want to set is a write that throws. Each of the three is exercised
// with the rules that touch the most of its payload, which is where an in-place write would be.

test('openai-chat-completions: produces a payload without writing into the frozen one', () => {
  const body = Object.freeze(ccPayload({ reasoning_effort: 'low' }));
  const applied = applyRulesToUpstreamOpenAIChatCompletions(body, {
    reasoning: { effort: 'xhigh' },
    verbosity: 'low',
    serviceTier: 'priority',
  });
  assertEquals(applied.reasoning_effort, 'xhigh');
  assertEquals(body.reasoning_effort, 'low');
});

test('openai-responses: produces a payload without writing into the frozen one', () => {
  const body = Object.freeze(resPayload({ reasoning: { effort: 'low' }, text: { verbosity: 'high' } }));
  const applied = applyRulesToUpstreamOpenAIResponses(body, {
    reasoning: { effort: 'xhigh', summary: 'detailed' },
    verbosity: 'low',
    serviceTier: 'priority',
  });
  assertEquals(applied.reasoning?.effort, 'xhigh');
  assertEquals(body.reasoning?.effort, 'low');
});

test('anthropic-messages: produces a payload without writing into the frozen one', () => {
  const body = Object.freeze(msgPayload({ thinking: { type: 'enabled', budget_tokens: 100 }, service_tier: 'priority' }));
  const applied = applyRulesToUpstreamAnthropicMessages(body, {
    reasoning: { effort: 'xhigh', adaptive: true, summary: 'concise' },
    serviceTier: 'fast',
  });
  assertEquals(applied.thinking?.type, 'adaptive');
  assertEquals(applied.speed, 'fast');
  assertEquals(applied.service_tier, undefined);
  assertEquals(body.thinking?.type, 'enabled');
  assertEquals(body.service_tier, 'priority');
});
