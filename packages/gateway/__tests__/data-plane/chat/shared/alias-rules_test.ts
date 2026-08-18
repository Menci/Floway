// Behavioral coverage for the target-side rule overlay. Each target's
// apply helper is exercised against an inbound payload IR; alias rules
// are authoritative — an existing IR field is OVERWRITTEN by a matching
// rule — and rules the target IR cannot express are silently dropped
// (there's no wire slot to put them on).

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
  applyRulesToUpstreamOpenAIChatCompletions(body, {});
  assertEquals(body.reasoning_effort, 'high');
  assertEquals(body.verbosity, 'low');
  assertEquals(body.service_tier, 'priority');
});

test('openai-chat-completions: rules stamp every supported native field onto the IR', () => {
  const body = ccPayload();
  applyRulesToUpstreamOpenAIChatCompletions(body, {
    reasoning: { effort: 'high' },
    verbosity: 'low',
    serviceTier: 'priority',
  });
  assertEquals(body.reasoning_effort, 'high');
  assertEquals(body.verbosity, 'low');
  assertEquals(body.service_tier, 'priority');
});

test('openai-chat-completions: budget_tokens / adaptive / summary have no native slot — silently dropped', () => {
  const body = ccPayload();
  applyRulesToUpstreamOpenAIChatCompletions(body, {
    reasoning: { budget_tokens: 1024, adaptive: true, summary: 'detailed' },
  });
  assertEquals(body.reasoning_effort, undefined);
  // Nothing surfaces on the CC IR because none of those rules map to
  // OpenAI Chat Completions' native fields.
  assertEquals('thinking_budget' in body, false);
  assertEquals('adaptive_thinking' in body, false);
  assertEquals('reasoning_summary' in body, false);
});

test('openai-chat-completions: alias rules overwrite existing IR fields', () => {
  const body = ccPayload({ reasoning_effort: 'low', verbosity: 'high', service_tier: 'default' });
  applyRulesToUpstreamOpenAIChatCompletions(body, {
    reasoning: { effort: 'xhigh' },
    verbosity: 'low',
    serviceTier: 'priority',
  });
  assertEquals(body.reasoning_effort, 'xhigh');
  assertEquals(body.verbosity, 'low');
  assertEquals(body.service_tier, 'priority');
});

// ── OpenAI Responses target ──

test('openai-responses: empty rules leave the payload unchanged', () => {
  const body = resPayload({ reasoning: { effort: 'high' }, text: { verbosity: 'low' }, service_tier: 'priority' });
  applyRulesToUpstreamOpenAIResponses(body, {});
  assertEquals(body.reasoning?.effort, 'high');
  assertEquals(body.text?.verbosity, 'low');
  assertEquals(body.service_tier, 'priority');
});

test('openai-responses: rules stamp every supported native field onto the IR', () => {
  const body = resPayload();
  applyRulesToUpstreamOpenAIResponses(body, {
    reasoning: { effort: 'high', summary: 'concise' },
    verbosity: 'medium',
    serviceTier: 'flex',
  });
  assertEquals(body.reasoning?.effort, 'high');
  assertEquals(body.reasoning?.summary, 'concise');
  assertEquals(body.text?.verbosity, 'medium');
  assertEquals(body.service_tier, 'flex');
});

test('openai-responses: budget_tokens / adaptive have no native slot — silently dropped', () => {
  const body = resPayload();
  applyRulesToUpstreamOpenAIResponses(body, {
    reasoning: { budget_tokens: 1024, adaptive: true },
  });
  assertEquals(body.reasoning, undefined);
  assertEquals('thinking_budget' in body, false);
  assertEquals('adaptive_thinking' in body, false);
});

test('openai-responses: alias rules overwrite owned fields while preserving reasoning.context', () => {
  const body = resPayload({
    reasoning: { effort: 'low', summary: 'auto', context: 'future_mode' },
    service_tier: 'default',
    text: { verbosity: 'high' },
  });
  applyRulesToUpstreamOpenAIResponses(body, {
    reasoning: { effort: 'xhigh', summary: 'detailed' },
    verbosity: 'low',
    serviceTier: 'priority',
  });
  assertEquals(body.reasoning, { effort: 'xhigh', summary: 'detailed', context: 'future_mode' });
  assertEquals(body.text?.verbosity, 'low');
  assertEquals(body.service_tier, 'priority');
});

// ── Anthropic Messages target ──

test('anthropic-messages: empty rules leave the payload unchanged', () => {
  const body = msgPayload({ output_config: { effort: 'high' }, thinking: { type: 'enabled', budget_tokens: 512 }, speed: 'fast' });
  applyRulesToUpstreamAnthropicMessages(body, {});
  assertEquals(body.output_config?.effort, 'high');
  assertEquals(body.thinking?.budget_tokens, 512);
  assertEquals(body.speed, 'fast');
});

test('anthropic-messages: effort lands on output_config, budget+adaptive land on thinking', () => {
  const body = msgPayload();
  applyRulesToUpstreamAnthropicMessages(body, {
    reasoning: { effort: 'high', budget_tokens: 2048 },
  });
  assertEquals(body.output_config?.effort, 'high');
  assertEquals(body.thinking?.type, 'enabled');
  assertEquals(body.thinking?.budget_tokens, 2048);
});

test('anthropic-messages: verbosity has no Anthropic-shaped slot — silently dropped', () => {
  const body = msgPayload();
  applyRulesToUpstreamAnthropicMessages(body, { verbosity: 'low' });
  assertEquals('verbosity' in body, false);
});

test('anthropic-messages: summary=concise|detailed collapses onto thinking.display=summarized (enables thinking)', () => {
  const body = msgPayload();
  applyRulesToUpstreamAnthropicMessages(body, { reasoning: { summary: 'concise' } });
  assertEquals(body.thinking?.type, 'enabled');
  assertEquals(body.thinking?.display, 'summarized');
});

test('anthropic-messages: summary=omitted collapses onto thinking.display=omitted', () => {
  const body = msgPayload();
  applyRulesToUpstreamAnthropicMessages(body, { reasoning: { summary: 'omitted' } });
  assertEquals(body.thinking?.display, 'omitted');
});

test('anthropic-messages: summary=auto is a no-op (Anthropic default takes over)', () => {
  const body = msgPayload();
  applyRulesToUpstreamAnthropicMessages(body, { reasoning: { summary: 'auto' } });
  assertEquals(body.thinking, undefined);
});

test('anthropic-messages: adaptive=true sets thinking.type=adaptive and ignores budget_tokens', () => {
  const body = msgPayload();
  applyRulesToUpstreamAnthropicMessages(body, { reasoning: { adaptive: true, budget_tokens: 4096 } });
  assertEquals(body.thinking?.type, 'adaptive');
});

test('anthropic-messages: adaptive=true strips a client-set budget_tokens from body.thinking', () => {
  const body = msgPayload();
  body.thinking = { type: 'enabled', budget_tokens: 5000 };
  applyRulesToUpstreamAnthropicMessages(body, { reasoning: { adaptive: true } });
  assertEquals(body.thinking?.type, 'adaptive');
  // The prior client budget must not leak into the adaptive block — adaptive
  // auto-determines the budget and a sibling budget_tokens violates the
  // rules-are-authoritative contract.
  assertEquals((body.thinking as { budget_tokens?: number }).budget_tokens, undefined);
});

test('anthropic-messages: serviceTier=fast maps to speed=fast (cross-protocol bridge)', () => {
  const body = msgPayload();
  applyRulesToUpstreamAnthropicMessages(body, { serviceTier: 'fast' });
  assertEquals(body.speed, 'fast');
  assertEquals(body.service_tier, undefined);
});

test('anthropic-messages: non-fast serviceTier lands on service_tier directly', () => {
  const body = msgPayload();
  applyRulesToUpstreamAnthropicMessages(body, { serviceTier: 'priority' });
  assertEquals(body.service_tier, 'priority');
  assertEquals(body.speed, undefined);
});

test('anthropic-messages: serviceTier=fast clears a pre-existing body.service_tier on the same payload', () => {
  // Upstream must never see both `speed` and `service_tier` set on the
  // same request — Anthropic treats them as alternates and the wire
  // semantics for a conflict are undefined. The overlay clears the
  // sibling field whichever branch it takes.
  const body = msgPayload({ service_tier: 'priority' });
  applyRulesToUpstreamAnthropicMessages(body, { serviceTier: 'fast' });
  assertEquals(body.speed, 'fast');
  assertEquals(body.service_tier, undefined);
});

test('anthropic-messages: non-fast serviceTier clears a pre-existing body.speed on the same payload', () => {
  const body = msgPayload({ speed: 'fast' });
  applyRulesToUpstreamAnthropicMessages(body, { serviceTier: 'priority' });
  assertEquals(body.service_tier, 'priority');
  assertEquals(body.speed, undefined);
});

test('anthropic-messages: alias rules overwrite existing thinking + output_config fields', () => {
  const body = msgPayload({ output_config: { effort: 'low' }, thinking: { type: 'enabled', budget_tokens: 100 } });
  applyRulesToUpstreamAnthropicMessages(body, { reasoning: { effort: 'xhigh', budget_tokens: 9999 } });
  assertEquals(body.output_config?.effort, 'xhigh');
  assertEquals(body.thinking?.budget_tokens, 9999);
});
