import { test, vi } from 'vitest';

import { answerClaudeCodeProbe } from '../../../../../src/data-plane/chat/anthropic-messages/interceptors/answer-claude-code-probe.ts';
import type { AnthropicMessagesInvocation } from '../../../../../src/data-plane/chat/anthropic-messages/interceptors/types.ts';
import { mockChatGatewayCtx } from '../../../../test-utils/gateway-ctx.ts';
import { collectAnthropicMessagesProtocolEventsToResult, type AnthropicMessagesPayload, type AnthropicMessagesStreamEventEx } from '@floway-dev/protocols/anthropic-messages';
import type { ProtocolFrame } from '@floway-dev/protocols/common';
import { type ExecuteResult, eventResult } from '@floway-dev/provider';
import { assert, assertEquals, stubModelCandidate, testTelemetryModelIdentity } from '@floway-dev/test-utils';

const stubCtx = mockChatGatewayCtx();

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
  system: [{ citations: null, type: 'text', text: "You are Claude Code, Anthropic's official CLI for Claude." }],
  messages: [{ role: 'user', content: [{ citations: null, type: 'text', text: 'Hi', cache_control: { type: 'ephemeral' } }] }],
  metadata: { user_id: 'user_0_account__session_0' },
  ...overrides,
});

const invocation = (payload: AnthropicMessagesPayload, userAgent: string | null = PROBE_USER_AGENT): AnthropicMessagesInvocation => ({
  payload,
  candidate: stubModelCandidate({ model: { endpoints: { openaiResponses: {} } } }),
  targetApi: 'openaiResponses',
  headers: new Headers(userAgent === null ? {} : { 'user-agent': userAgent }),
  anthropicBeta: [],
});

const passthrough = async (): Promise<ExecuteResult<ProtocolFrame<AnthropicMessagesStreamEventEx>>> =>
  eventResult((async function* (): AsyncGenerator<ProtocolFrame<AnthropicMessagesStreamEventEx>> {})(), testTelemetryModelIdentity);

const runProbe = async (input: AnthropicMessagesInvocation) => {
  const run = vi.fn(passthrough);
  const result = await answerClaudeCodeProbe(input, stubCtx, run);
  return { result, run };
};

const assertForwarded = async (input: AnthropicMessagesInvocation, message: string) => {
  const { run } = await runProbe(input);
  assertEquals(run.mock.calls.length, 1, message);
};

const assertAnswered = async (input: AnthropicMessagesInvocation, message: string) => {
  const { run } = await runProbe(input);
  assertEquals(run.mock.calls.length, 0, message);
};

test('answers the /model validation probe without dialing the upstream', async () => {
  const { result, run } = await runProbe(invocation(probePayload()));

  assertEquals(run.mock.calls.length, 0);
  assert(result.type === 'events');
  const message = await collectAnthropicMessagesProtocolEventsToResult(result.events);
  assertEquals(message.type, 'message');
  assertEquals(message.role, 'assistant');
  assertEquals(message.model, 'test-model');
  assertEquals(message.content, []);
  assertEquals(message.stop_reason, 'max_tokens');
  assertEquals(message.usage.input_tokens, 0);
  assertEquals(message.usage.output_tokens, 0);
  assert(message.id.startsWith('msg_'));
});

test('answers every fixed probe prompt, in block and bare-string form', async () => {
  for (const prompt of ['Hi', 'test']) {
    await assertAnswered(invocation(probePayload({ messages: [{ role: 'user', content: prompt }] })), `bare string: ${prompt}`);
    await assertAnswered(invocation(probePayload({ messages: [{ role: 'user', content: [{ citations: null, type: 'text', text: prompt }] }] })), `text block: ${prompt}`);
  }
});

test('forwards the probe prompts the gateway cannot answer truthfully', async () => {
  // `quota` reads rate-limit response headers a synthesized turn cannot carry;
  // `.` only ever reaches a Bedrock / Vertex / Mantle base URL; `hello` is a
  // third-party report's reconstruction that no observed build sends.
  for (const prompt of ['quota', '.', 'hello']) {
    await assertForwarded(invocation(probePayload({ messages: [{ role: 'user', content: prompt }] })), `prompt: ${prompt}`);
  }
});

test('forwards a one-token request from a client that is not Claude Code', async () => {
  await assertForwarded(invocation(probePayload(), 'python-httpx/0.28.1'), 'other client');
  await assertForwarded(invocation(probePayload(), null), 'no user-agent');
});

test('forwards a Claude Code turn whose output cap is not one token', async () => {
  await assertForwarded(invocation(probePayload({ max_tokens: 32_000 })), 'max_tokens 32000');
});

test('forwards a multi-turn conversation that happens to end on a probe prompt', async () => {
  await assertForwarded(invocation(probePayload({
    messages: [
      { role: 'user', content: 'Hi' },
      { role: 'assistant', content: 'Hello!' },
      { role: 'user', content: 'Hi' },
    ],
  })), 'three turns');
});
