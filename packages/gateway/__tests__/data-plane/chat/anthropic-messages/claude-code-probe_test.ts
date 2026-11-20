import { test } from 'vitest';

import { isClaudeCodeProbe, probeFrames } from '../../../../src/data-plane/chat/anthropic-messages/claude-code-probe.ts';
import { collectAnthropicMessagesProtocolEventsToResult, type AnthropicMessagesPayload } from '@floway-dev/protocols/anthropic-messages';
import { assert, assertEquals } from '@floway-dev/test-utils';

// The CLI emits `claude-cli/<version> (external, <entrypoint>…)`, where the
// entrypoint substitutes for `cli` and up to three optional segments append —
// which is why the predicate anchors on the `claude-cli/<semver>` prefix only.
// This is the default entrypoint form.
const PROBE_USER_AGENT = 'claude-cli/2.1.226 (external, cli)';

// The shape of the 2.1.226 `/model` validation probe: one user turn holding
// one ephemeral text block, `max_tokens: 1`, no tools. The real body also
// carries the CLI's system-prompt array and a `betas` list, neither of which
// the predicate looks at.
const probePayload = (overrides: Partial<AnthropicMessagesPayload> = {}): AnthropicMessagesPayload => ({
  model: 'test-model',
  max_tokens: 1,
  system: [{ type: 'text', text: "You are Claude Code, Anthropic's official CLI for Claude." }],
  messages: [{ role: 'user', content: [{ type: 'text', text: 'Hi', cache_control: { type: 'ephemeral' } }] }],
  metadata: { user_id: 'user_0_account__session_0' },
  ...overrides,
});

/** What the stage that answers this asks: is the turn in front of it the CLI's own probe?
 *  Everything below is that predicate, over the bodies the CLI has been observed to send. */
const invocation = (payload: AnthropicMessagesPayload, userAgent: string | null = PROBE_USER_AGENT): boolean =>
  isClaudeCodeProbe(payload, new Headers(userAgent === null ? {} : { 'user-agent': userAgent }));

const assertForwarded = (answered: boolean, message: string) => { assertEquals(answered, false, message); };

const assertAnswered = (answered: boolean, message: string) => { assertEquals(answered, true, message); };

test('answers the /model validation probe without dialing the upstream', async () => {
  assertEquals(invocation(probePayload()), true);

  const message = await collectAnthropicMessagesProtocolEventsToResult(probeFrames('test-model'));
  assertEquals(message.type, 'message');
  assertEquals(message.role, 'assistant');
  assertEquals(message.model, 'test-model');
  assertEquals(message.content, []);
  assertEquals(message.stop_reason, 'max_tokens');
  assertEquals(message.usage.input_tokens, 0);
  assertEquals(message.usage.output_tokens, 0);
  assert(message.id.startsWith('msg_'));
});

test('answers every fixed probe prompt, in block and bare-string form', () => {
  for (const prompt of ['Hi', 'test']) {
    assertAnswered(invocation(probePayload({ messages: [{ role: 'user', content: prompt }] })), `bare string: ${prompt}`);
    assertAnswered(invocation(probePayload({ messages: [{ role: 'user', content: [{ type: 'text', text: prompt }] }] })), `text block: ${prompt}`);
  }
});

test('forwards the probe prompts the gateway cannot answer truthfully', () => {
  // `quota` reads rate-limit response headers a synthesized turn cannot carry;
  // `.` only ever reaches a Bedrock / Vertex / Mantle base URL; `hello` is a
  // third-party report's reconstruction that no observed build sends.
  for (const prompt of ['quota', '.', 'hello']) {
    assertForwarded(invocation(probePayload({ messages: [{ role: 'user', content: prompt }] })), `prompt: ${prompt}`);
  }
});

test('forwards a probe prompt whose casing the CLI has never been observed to send', () => {
  assertForwarded(invocation(probePayload({ messages: [{ role: 'user', content: 'HI' }] })), 'uppercased');
});

test('forwards a one-token request from a client that is not Claude Code', () => {
  assertForwarded(invocation(probePayload(), 'python-httpx/0.28.1'), 'other client');
  assertForwarded(invocation(probePayload(), null), 'no user-agent');
});

test('forwards a Claude Code turn whose output cap is not one token', () => {
  assertForwarded(invocation(probePayload({ max_tokens: 32_000 })), 'max_tokens 32000');
});

test('forwards a Claude Code turn that carries the session tools', () => {
  assertForwarded(invocation(probePayload({
    tools: [{ name: 'Bash', input_schema: { type: 'object' } }],
  })), 'tools present');
});

test('forwards a conversation whose sole turn is not one of the fixed prompts', () => {
  assertForwarded(invocation(probePayload({
    messages: [{ role: 'user', content: 'Hi, can you explain this file?' }],
  })), 'real question');
});

test('forwards a multi-turn conversation that happens to end on a probe prompt', () => {
  assertForwarded(invocation(probePayload({
    messages: [
      { role: 'user', content: 'Hi' },
      { role: 'assistant', content: 'Hello!' },
      { role: 'user', content: 'Hi' },
    ],
  })), 'three turns');
});

test('forwards a sole turn that carries more than one block', () => {
  assertForwarded(invocation(probePayload({
    messages: [{ role: 'user', content: [{ type: 'text', text: 'Hi' }, { type: 'text', text: 'and explain this file' }] }],
  })), 'two text blocks');
});

test('forwards a sole turn that is not a user turn', () => {
  assertForwarded(invocation(probePayload({ messages: [{ role: 'assistant', content: 'Hi' }] })), 'assistant role');
  assertForwarded(invocation(probePayload({ messages: [{ role: 'system', content: 'Hi' }] })), 'system role');
});

test('forwards a turn whose sole block is not text', () => {
  assertForwarded(invocation(probePayload({
    messages: [{ role: 'user', content: [{ type: 'image', source: { type: 'base64', media_type: 'image/png', data: 'AA==' } }] }],
  })), 'image block');
});
