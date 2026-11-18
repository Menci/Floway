// Behavioral coverage for the target-side rule overlay. Each target's
// apply helper is exercised against an inbound payload IR; alias rules
// are authoritative — an existing IR field is OVERWRITTEN by a matching
// rule — and rules the target IR cannot express are silently dropped
// (there's no wire slot to put them on).

import { test } from 'vitest';

import { applyRulesToUpstreamGeminiGenerateContent, applyRulesToUpstreamAnthropicMessages, applyRulesToUpstreamOpenAIResponses } from '../../../../src/data-plane/chat/shared/alias-rules.ts';
import type { AnthropicMessagesPayload } from '@floway-dev/protocols/anthropic-messages';
import type { GeminiGenerateContentPayload } from '@floway-dev/protocols/gemini-generate-content';
import type { OpenAIResponsesPayloadEx } from '@floway-dev/protocols/openai-responses';
import { assertEquals } from '@floway-dev/test-utils';

const resPayload = (overrides: Partial<OpenAIResponsesPayloadEx> = {}): OpenAIResponsesPayloadEx => ({
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

test('responses: alias rules overwrite owned fields while preserving reasoning.context', () => {
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

test('messages: summary updates display without changing enabled thinking', () => {
  const body = msgPayload();
  body.thinking = { type: 'enabled', budget_tokens: 2048 };
  applyRulesToUpstreamAnthropicMessages(body, { reasoning: { summary: 'concise' } });
  assertEquals(body.thinking, { type: 'enabled', budget_tokens: 2048, display: 'summarized' });
});

test('messages: adaptive=true strips a client-set budget_tokens from body.thinking', () => {
  const body = msgPayload();
  body.thinking = { type: 'enabled', budget_tokens: 5000 };
  applyRulesToUpstreamAnthropicMessages(body, { reasoning: { adaptive: true } });
  assertEquals(body.thinking?.type, 'adaptive');
  // The prior client budget must not leak into the adaptive block — adaptive
  // auto-determines the budget and a sibling budget_tokens violates the
  // rules-are-authoritative contract.
  assertEquals((body.thinking as { budget_tokens?: number }).budget_tokens, undefined);
});

test('messages: serviceTier=fast clears a pre-existing body.service_tier on the same payload', () => {
  // Upstream must never see both `speed` and `service_tier` set on the
  // same request — Anthropic treats them as alternates and the wire
  // semantics for a conflict are undefined. The overlay clears the
  // sibling field whichever branch it takes.
  const body = msgPayload({ service_tier: 'flex' });
  applyRulesToUpstreamAnthropicMessages(body, { serviceTier: 'fast' });
  assertEquals(body.speed, 'fast');
  assertEquals(body.service_tier, undefined);
});

const geminiPayload = (overrides: Partial<GeminiGenerateContentPayload> = {}): GeminiGenerateContentPayload => ({
  contents: [{ role: 'user', parts: [{ text: 'hi' }] }],
  ...overrides,
});

test('gemini: none disables thinking through a zero budget because there is no level for it', () => {
  const body = geminiPayload({ generationConfig: { thinkingConfig: { thinkingLevel: 'HIGH' } } });
  applyRulesToUpstreamGeminiGenerateContent(body, { reasoning: { effort: 'none' } });
  assertEquals(body.generationConfig?.thinkingConfig, { thinkingBudget: 0 });
});

test('gemini: a budget replaces a client-stated level rather than joining it', () => {
  const body = geminiPayload({ generationConfig: { thinkingConfig: { thinkingLevel: 'LOW', includeThoughts: true } } });
  applyRulesToUpstreamGeminiGenerateContent(body, { reasoning: { budget_tokens: 2048 } });
  assertEquals(body.generationConfig?.thinkingConfig, { includeThoughts: true, thinkingBudget: 2048 });
});

test('gemini: a known effort takes the uppercase wire level while a vendor-specific one travels verbatim', () => {
  const known = geminiPayload();
  applyRulesToUpstreamGeminiGenerateContent(known, { reasoning: { effort: 'xhigh' } });
  assertEquals(known.generationConfig?.thinkingConfig, { thinkingLevel: 'XHIGH' });
  const body = geminiPayload();
  applyRulesToUpstreamGeminiGenerateContent(body, {
    reasoning: { effort: 'turbo', adaptive: true, summary: 'detailed' },
    verbosity: 'low',
  });
  assertEquals(body.generationConfig?.thinkingConfig, { thinkingLevel: 'turbo' });
});

test('gemini: the fast serviceTier alias takes the priority spelling the wire accepts', () => {
  const body = geminiPayload();
  applyRulesToUpstreamGeminiGenerateContent(body, { serviceTier: 'fast' });
  assertEquals(body.serviceTier, 'priority');
});
