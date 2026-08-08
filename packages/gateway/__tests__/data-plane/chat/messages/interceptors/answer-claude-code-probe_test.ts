import { test, vi } from 'vitest';

import { answerClaudeCodeProbe, isClaudeCodeProbe } from '../../../../../src/data-plane/chat/messages/interceptors/answer-claude-code-probe.ts';
import type { MessagesInvocation } from '../../../../../src/data-plane/chat/messages/interceptors/types.ts';
import { mockChatGatewayCtx } from '../../../../test-utils/gateway-ctx.ts';
import type { ProtocolFrame } from '@floway-dev/protocols/common';
import { collectMessagesProtocolEventsToResult, type MessagesPayload, type MessagesStreamEvent } from '@floway-dev/protocols/messages';
import { type ExecuteResult, eventResult } from '@floway-dev/provider';
import { assert, assertEquals, stubModelCandidate, testTelemetryModelIdentity } from '@floway-dev/test-utils';

const stubCtx = mockChatGatewayCtx();

// The 2.1.226 `/model` probe, byte for byte: one user turn, one ephemeral text
// block, `max_tokens: 1`, no tools, and the SDK's `claude-cli` User-Agent.
const PROBE_USER_AGENT = 'claude-cli/2.1.226 (external, cli)';

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

test('answers every fixed side-query prompt, in block and bare-string form', async () => {
  for (const prompt of ['Hi', 'hello', 'quota', 'test', '.']) {
    assert(isClaudeCodeProbe(probePayload({ messages: [{ role: 'user', content: prompt }] }), new Headers({ 'user-agent': PROBE_USER_AGENT })), `bare string: ${prompt}`);
    assert(isClaudeCodeProbe(probePayload({ messages: [{ role: 'user', content: [{ type: 'text', text: prompt }] }] }), new Headers({ 'user-agent': PROBE_USER_AGENT })), `text block: ${prompt}`);
  }
});

test('forwards a one-token request from a client that is not Claude Code', async () => {
  const { run } = await runProbe(invocation(probePayload(), 'python-httpx/0.28.1'));
  assertEquals(run.mock.calls.length, 1);

  const { run: unidentified } = await runProbe(invocation(probePayload(), null));
  assertEquals(unidentified.mock.calls.length, 1);
});

test('forwards a Claude Code turn whose output cap is not one token', async () => {
  const { run } = await runProbe(invocation(probePayload({ max_tokens: 32_000 })));
  assertEquals(run.mock.calls.length, 1);
});

test('forwards a Claude Code turn that carries the session tools', async () => {
  const { run } = await runProbe(invocation(probePayload({
    tools: [{ name: 'Bash', input_schema: { type: 'object' } }],
  })));
  assertEquals(run.mock.calls.length, 1);
});

test('forwards a conversation whose sole turn is not one of the fixed prompts', async () => {
  const { run } = await runProbe(invocation(probePayload({
    messages: [{ role: 'user', content: 'Hi, can you explain this file?' }],
  })));
  assertEquals(run.mock.calls.length, 1);
});

test('forwards a multi-turn conversation that happens to end on a probe prompt', async () => {
  const { run } = await runProbe(invocation(probePayload({
    messages: [
      { role: 'user', content: 'Hi' },
      { role: 'assistant', content: 'Hello!' },
      { role: 'user', content: 'Hi' },
    ],
  })));
  assertEquals(run.mock.calls.length, 1);
});

test('forwards a turn whose sole block is not text', async () => {
  const { run } = await runProbe(invocation(probePayload({
    messages: [{ role: 'user', content: [{ type: 'image', source: { type: 'base64', media_type: 'image/png', data: 'AA==' } }] }],
  })));
  assertEquals(run.mock.calls.length, 1);
});
