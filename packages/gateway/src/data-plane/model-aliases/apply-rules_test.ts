// Behavioral coverage for the target-side rule overlay. Each target's
// apply helper is exercised against an inbound payload IR; alias rules
// are authoritative — an existing IR field is OVERWRITTEN by a matching
// rule — and rules the target IR cannot express are silently dropped
// (there's no wire slot to put them on).

import { test } from 'vitest';

import { applyRulesToUpstreamChatCompletions, applyRulesToUpstreamMessages, applyRulesToUpstreamResponses } from './apply-rules.ts';
import type { ChatCompletionsPayload } from '@floway-dev/protocols/chat-completions';
import type { MessagesPayload } from '@floway-dev/protocols/messages';
import type { ResponsesPayload } from '@floway-dev/protocols/responses';
import { assertEquals } from '@floway-dev/test-utils';

const ccPayload = (overrides: Partial<ChatCompletionsPayload> = {}): ChatCompletionsPayload => ({
  model: 'gpt-5.4',
  messages: [{ role: 'user', content: 'hi' }],
  ...overrides,
});

const resPayload = (overrides: Partial<ResponsesPayload> = {}): ResponsesPayload => ({
  model: 'gpt-5.4',
  input: 'hi',
  ...overrides,
});

const msgPayload = (overrides: Partial<MessagesPayload> = {}): MessagesPayload => ({
  model: 'claude-opus-4-7',
  max_tokens: 32,
  messages: [{ role: 'user', content: 'hi' }],
  ...overrides,
});

// ── ChatCompletions target ──

test('chat-completions: empty rules leave the payload unchanged', () => {
  const body = ccPayload({ reasoning_effort: 'high', verbosity: 'low', service_tier: 'priority' });
  applyRulesToUpstreamChatCompletions(body, {});
  assertEquals(body.reasoning_effort, 'high');
  assertEquals(body.verbosity, 'low');
  assertEquals(body.service_tier, 'priority');
});

test('chat-completions: rules stamp every supported native field onto the IR', () => {
  const body = ccPayload();
  applyRulesToUpstreamChatCompletions(body, {
    reasoning: { effort: 'high' },
    verbosity: 'low',
    serviceTier: 'priority',
  });
  assertEquals(body.reasoning_effort, 'high');
  assertEquals(body.verbosity, 'low');
  assertEquals(body.service_tier, 'priority');
});

test('chat-completions: budget_tokens / adaptive / summary have no native slot — silently dropped', () => {
  const body = ccPayload();
  applyRulesToUpstreamChatCompletions(body, {
    reasoning: { budget_tokens: 1024, adaptive: true, summary: 'detailed' },
  });
  assertEquals(body.reasoning_effort, undefined);
  // Nothing surfaces on the CC IR because none of those rules map to
  // Chat Completions' native fields.
  assertEquals('thinking_budget' in body, false);
  assertEquals('adaptive_thinking' in body, false);
  assertEquals('reasoning_summary' in body, false);
});

test('chat-completions: alias rules overwrite existing IR fields', () => {
  const body = ccPayload({ reasoning_effort: 'low', verbosity: 'high', service_tier: 'default' });
  applyRulesToUpstreamChatCompletions(body, {
    reasoning: { effort: 'xhigh' },
    verbosity: 'low',
    serviceTier: 'priority',
  });
  assertEquals(body.reasoning_effort, 'xhigh');
  assertEquals(body.verbosity, 'low');
  assertEquals(body.service_tier, 'priority');
});

// ── Responses target ──

test('responses: empty rules leave the payload unchanged', () => {
  const body = resPayload({ reasoning: { effort: 'high' }, text: { verbosity: 'low' }, service_tier: 'priority' });
  applyRulesToUpstreamResponses(body, {});
  assertEquals(body.reasoning?.effort, 'high');
  assertEquals(body.text?.verbosity, 'low');
  assertEquals(body.service_tier, 'priority');
});

test('responses: rules stamp every supported native field onto the IR', () => {
  const body = resPayload();
  applyRulesToUpstreamResponses(body, {
    reasoning: { effort: 'high', summary: 'concise' },
    verbosity: 'medium',
    serviceTier: 'flex',
  });
  assertEquals(body.reasoning?.effort, 'high');
  assertEquals(body.reasoning?.summary, 'concise');
  assertEquals(body.text?.verbosity, 'medium');
  assertEquals(body.service_tier, 'flex');
});

test('responses: budget_tokens / adaptive have no native slot — silently dropped', () => {
  const body = resPayload();
  applyRulesToUpstreamResponses(body, {
    reasoning: { budget_tokens: 1024, adaptive: true },
  });
  assertEquals(body.reasoning, undefined);
  assertEquals('thinking_budget' in body, false);
  assertEquals('adaptive_thinking' in body, false);
});

test('responses: alias rules overwrite existing reasoning + service_tier fields', () => {
  const body = resPayload({ reasoning: { effort: 'low', summary: 'auto' }, service_tier: 'default', text: { verbosity: 'high' } });
  applyRulesToUpstreamResponses(body, {
    reasoning: { effort: 'xhigh', summary: 'detailed' },
    verbosity: 'low',
    serviceTier: 'priority',
  });
  assertEquals(body.reasoning?.effort, 'xhigh');
  assertEquals(body.reasoning?.summary, 'detailed');
  assertEquals(body.text?.verbosity, 'low');
  assertEquals(body.service_tier, 'priority');
});

// ── Messages target ──

test('messages: empty rules leave the payload unchanged', () => {
  const body = msgPayload({ output_config: { effort: 'high' }, thinking: { type: 'enabled', budget_tokens: 512 }, speed: 'fast' });
  applyRulesToUpstreamMessages(body, {});
  assertEquals(body.output_config?.effort, 'high');
  assertEquals(body.thinking?.budget_tokens, 512);
  assertEquals(body.speed, 'fast');
});

test('messages: effort lands on output_config, budget+adaptive land on thinking', () => {
  const body = msgPayload();
  applyRulesToUpstreamMessages(body, {
    reasoning: { effort: 'high', budget_tokens: 2048 },
  });
  assertEquals(body.output_config?.effort, 'high');
  assertEquals(body.thinking?.type, 'enabled');
  assertEquals(body.thinking?.budget_tokens, 2048);
});

test('messages: verbosity has no Anthropic-shaped slot — silently dropped', () => {
  const body = msgPayload();
  applyRulesToUpstreamMessages(body, { verbosity: 'low' });
  assertEquals('verbosity' in body, false);
});

test('messages: summary=concise|detailed collapses onto thinking.display=summarized (enables thinking)', () => {
  const body = msgPayload();
  applyRulesToUpstreamMessages(body, { reasoning: { summary: 'concise' } });
  assertEquals(body.thinking?.type, 'enabled');
  assertEquals(body.thinking?.display, 'summarized');
});

test('messages: summary=omitted collapses onto thinking.display=omitted', () => {
  const body = msgPayload();
  applyRulesToUpstreamMessages(body, { reasoning: { summary: 'omitted' } });
  assertEquals(body.thinking?.display, 'omitted');
});

test('messages: summary=auto is a no-op (Anthropic default takes over)', () => {
  const body = msgPayload();
  applyRulesToUpstreamMessages(body, { reasoning: { summary: 'auto' } });
  assertEquals(body.thinking, undefined);
});

test('messages: adaptive=true sets thinking.type=adaptive and ignores budget_tokens', () => {
  const body = msgPayload();
  applyRulesToUpstreamMessages(body, { reasoning: { adaptive: true, budget_tokens: 4096 } });
  assertEquals(body.thinking?.type, 'adaptive');
});

test('messages: serviceTier=fast maps to speed=fast (cross-protocol bridge)', () => {
  const body = msgPayload();
  applyRulesToUpstreamMessages(body, { serviceTier: 'fast' });
  assertEquals(body.speed, 'fast');
  assertEquals(body.service_tier, undefined);
});

test('messages: non-fast serviceTier lands on service_tier directly', () => {
  const body = msgPayload();
  applyRulesToUpstreamMessages(body, { serviceTier: 'priority' });
  assertEquals(body.service_tier, 'priority');
  assertEquals(body.speed, undefined);
});

test('messages: serviceTier=fast clears a pre-existing body.service_tier on the same payload', () => {
  // Upstream must never see both `speed` and `service_tier` set on the
  // same request — Anthropic treats them as alternates and the wire
  // semantics for a conflict are undefined. The overlay clears the
  // sibling field whichever branch it takes.
  const body = msgPayload({ service_tier: 'priority' });
  applyRulesToUpstreamMessages(body, { serviceTier: 'fast' });
  assertEquals(body.speed, 'fast');
  assertEquals(body.service_tier, undefined);
});

test('messages: non-fast serviceTier clears a pre-existing body.speed on the same payload', () => {
  const body = msgPayload({ speed: 'fast' });
  applyRulesToUpstreamMessages(body, { serviceTier: 'priority' });
  assertEquals(body.service_tier, 'priority');
  assertEquals(body.speed, undefined);
});

test('messages: alias rules overwrite existing thinking + output_config fields', () => {
  const body = msgPayload({ output_config: { effort: 'low' }, thinking: { type: 'enabled', budget_tokens: 100 } });
  applyRulesToUpstreamMessages(body, { reasoning: { effort: 'xhigh', budget_tokens: 9999 } });
  assertEquals(body.output_config?.effort, 'xhigh');
  assertEquals(body.thinking?.budget_tokens, 9999);
});
