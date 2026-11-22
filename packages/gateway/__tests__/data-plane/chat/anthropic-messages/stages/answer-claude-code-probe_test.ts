import { expect, test } from 'vitest';

import { anthropicFacts, anthropicPayload } from './fixtures.ts';
import { answerClaudeCodeProbe, isClaudeCodeProbe } from '../../../../../src/data-plane/chat/anthropic-messages/stages/answer-claude-code-probe.ts';
import { createManagedProtocolFrames, runChatStage } from '../../../../test-utils/chat-pipeline.ts';
import type { AnthropicMessagesStreamEventEx } from '@floway-dev/protocols/anthropic-messages';
import { testTelemetryModelIdentity } from '@floway-dev/test-utils';

const probeUserAgent = 'claude-cli/2.1.226 (external, cli)';
const probePayload = () => anthropicPayload({
  max_tokens: 1,
  messages: [{ role: 'user', content: [{ citations: null, type: 'text', text: 'Hi', cache_control: { type: 'ephemeral' } }] }],
});

const forwarded = (_facts: unknown, env: import('@floway-dev/pipeline').StageEnv<any>) => ({
  type: 'events' as const,
  events: createManagedProtocolFrames<AnthropicMessagesStreamEventEx>(env, []),
  modelIdentity: testTelemetryModelIdentity,
});

test('recognizes only the observed Claude Code one-token probe prompts', () => {
  const facts = anthropicFacts(probePayload(), { headers: [['user-agent', probeUserAgent]] });
  expect(isClaudeCodeProbe(facts)).toBe(true);
  expect(isClaudeCodeProbe(anthropicFacts(probePayload(), { headers: [['user-agent', 'python-httpx/0.28.1']] }))).toBe(false);
  expect(isClaudeCodeProbe(anthropicFacts(anthropicPayload({ max_tokens: 1, messages: [{ role: 'user', content: 'quota' }] }), {
    headers: [['user-agent', probeUserAgent]],
  }))).toBe(false);
});

test('short-circuits the probe with a synthetic terminal stream and records zero usage', async () => {
  const { outcome, services } = await runChatStage({
    stage: answerClaudeCodeProbe,
    facts: anthropicFacts(probePayload(), { headers: [['user-agent', probeUserAgent]] }),
    next: forwarded,
  });
  expect(outcome.type).toBe('events');
  if (outcome.type !== 'events') throw new Error('expected events');
  expect(outcome.usageId).toBeDefined();
  expect(services.usageLedger.read(outcome.usageId, {
    modelIdentity: outcome.modelIdentity,
    performance: outcome.performance,
  }).billableUsage).toEqual({ input: 0, cacheRead: 0, cacheWrite: 0, cacheWrite1h: 0, output: 0 });
  const frames: string[] = [];
  for await (const frame of outcome.events) if (frame.type === 'event') frames.push(frame.event.type);
  expect(frames).toEqual(['message_start', 'message_delta', 'message_stop']);
});
