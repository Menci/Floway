import { test, vi } from 'vitest';

import { answerClaudeCodeProbe } from '../../../../../src/data-plane/chat/messages/interceptors/answer-claude-code-probe.ts';
import type { MessagesInvocation } from '../../../../../src/data-plane/chat/messages/interceptors/types.ts';
import { mockChatGatewayCtx } from '../../../../test-utils/gateway-ctx.ts';
import type { ProtocolFrame } from '@floway-dev/protocols/common';
import { collectMessagesProtocolEventsToResult, type MessagesPayload, type MessagesStreamEvent } from '@floway-dev/protocols/messages';
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
const probePayload = (overrides: Partial<MessagesPayload> = {}): MessagesPayload => ({
  model: 'test-model',
  max_tokens: 1,
  system: [{ type: 'text', text: "You are Claude Code, Anthropic's official CLI for Claude." }],
  messages: [{ role: 'user', content: [{ type: 'text', text: 'Hi', cache_control: { type: 'ephemeral' } }] }],
  metadata: { user_id: 'user_0_account__session_0' },
  ...overrides,
});

const invocation = (payload: MessagesPayload, userAgent: string | null = PROBE_USER_AGENT): MessagesInvocation => ({
  payload,
  candidate: stubModelCandidate({ model: { endpoints: { responses: {} } } }),
  targetApi: 'responses',
  headers: new Headers(userAgent === null ? {} : { 'user-agent': userAgent }),
});

const passthrough = async (): Promise<ExecuteResult<ProtocolFrame<MessagesStreamEvent>>> =>
  eventResult((async function* (): AsyncGenerator<ProtocolFrame<MessagesStreamEvent>> {})(), testTelemetryModelIdentity);

const runProbe = async (input: MessagesInvocation) => {
  const run = vi.fn(passthrough);
  const result = await answerClaudeCodeProbe(input, stubCtx, run);
  return { result, run };
};

const assertForwarded = async (input: MessagesInvocation, message: string) => {
  const { run } = await runProbe(input);
  assertEquals(run.mock.calls.length, 1, message);
};

const assertAnswered = async (input: MessagesInvocation, message: string) => {
  const { run } = await runProbe(input);
  assertEquals(run.mock.calls.length, 0, message);
};

test('answers the /model validation probe without dialing the upstream', async () => {
  const { result, run } = await runProbe(invocation(probePayload()));

  assertEquals(run.mock.calls.length, 0);
  assert(result.type === 'events');
  const message = await collectMessagesProtocolEventsToResult(result.events);
  assertEquals(message.type, 'message');
  assertEquals(message.role, 'assistant');
  assertEquals(message.model, 'test-model');
  assertEquals(message.content, []);
  assertEquals(message.stop_reason, 'max_tokens');
  assertEquals(message.usage.input_tokens, 0);
  assertEquals(message.usage.output_tokens, 0);
  assert(message.id.startsWith('msg_'));
});

test('reports no performance context so the turn contributes no latency sample', async () => {
  const { result } = await runProbe(invocation(probePayload()));

  assert(result.type === 'events');
  assertEquals(result.performance, undefined);
  assertEquals(result.finalMetadata, undefined);
});

test('answers every fixed probe prompt, in block and bare-string form', async () => {
  for (const prompt of ['Hi', 'test']) {
    await assertAnswered(invocation(probePayload({ messages: [{ role: 'user', content: prompt }] })), `bare string: ${prompt}`);
    await assertAnswered(invocation(probePayload({ messages: [{ role: 'user', content: [{ type: 'text', text: prompt }] }] })), `text block: ${prompt}`);
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

test('forwards a probe prompt whose casing the CLI has never been observed to send', async () => {
  await assertForwarded(invocation(probePayload({ messages: [{ role: 'user', content: 'HI' }] })), 'uppercased');
});

test('forwards a one-token request from a client that is not Claude Code', async () => {
  await assertForwarded(invocation(probePayload(), 'python-httpx/0.28.1'), 'other client');
  await assertForwarded(invocation(probePayload(), null), 'no user-agent');
});

test('forwards a Claude Code turn whose output cap is not one token', async () => {
  await assertForwarded(invocation(probePayload({ max_tokens: 32_000 })), 'max_tokens 32000');
});

test('forwards a Claude Code turn that carries the session tools', async () => {
  await assertForwarded(invocation(probePayload({
    tools: [{ name: 'Bash', input_schema: { type: 'object' } }],
  })), 'tools present');
});

test('forwards a conversation whose sole turn is not one of the fixed prompts', async () => {
  await assertForwarded(invocation(probePayload({
    messages: [{ role: 'user', content: 'Hi, can you explain this file?' }],
  })), 'real question');
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

test('forwards a sole turn that carries more than one block', async () => {
  await assertForwarded(invocation(probePayload({
    messages: [{ role: 'user', content: [{ type: 'text', text: 'Hi' }, { type: 'text', text: 'and explain this file' }] }],
  })), 'two text blocks');
});

test('forwards a sole turn that is not a user turn', async () => {
  await assertForwarded(invocation(probePayload({ messages: [{ role: 'assistant', content: 'Hi' }] })), 'assistant role');
  await assertForwarded(invocation(probePayload({ messages: [{ role: 'system', content: 'Hi' }] })), 'system role');
});

test('forwards a turn whose sole block is not text', async () => {
  await assertForwarded(invocation(probePayload({
    messages: [{ role: 'user', content: [{ type: 'image', source: { type: 'base64', media_type: 'image/png', data: 'AA==' } }] }],
  })), 'image block');
});
