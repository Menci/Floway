import { test, vi } from 'vitest';

import { answerClaudeCodeProbe } from '../../../../../src/data-plane/chat/anthropic-messages/interceptors/answer-claude-code-probe.ts';
import type { AnthropicMessagesInvocation } from '../../../../../src/data-plane/chat/anthropic-messages/interceptors/types.ts';
import { mockChatGatewayCtx } from '../../../../test-utils/gateway-ctx.ts';
import { type AnthropicMessagesPayload, type AnthropicMessagesStreamEventEx } from '@floway-dev/protocols/anthropic-messages';
import type { ProtocolFrame } from '@floway-dev/protocols/common';
import { type ExecuteResult, eventResult } from '@floway-dev/provider';
import { assertEquals, stubModelCandidate, testTelemetryModelIdentity } from '@floway-dev/test-utils';

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

// The answered path is proven end to end in `http_test.ts`.
test('forwards the probe prompts the gateway cannot answer truthfully', async () => {
  // `quota` reads rate-limit response headers a synthesized turn cannot carry.
  await assertForwarded(invocation(probePayload({ messages: [{ role: 'user', content: 'quota' }] })), 'quota');
});

test('forwards a one-token request from a client that is not Claude Code', async () => {
  await assertForwarded(invocation(probePayload(), 'python-httpx/0.28.1'), 'other client');
  await assertForwarded(invocation(probePayload(), null), 'no user-agent');
});
