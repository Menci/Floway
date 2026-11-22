import { test } from 'vitest';

import { CLAUDE_AGENT_USER_AGENT } from '../../../src/auth.ts';
import { fakeCopilotWire, invokeAnthropic } from '../../pipeline-fixture.ts';
import { assertEquals, sseResponse } from '@floway-dev/test-utils';

test('Claude Code SDK compact request overrides compact intent and threads its session', async () => {
  let wire: Headers | undefined;
  const { provider, model, fetcher } = await fakeCopilotWire('/v1/messages', 'claude-test', request => {
    wire = request.headers;
    return sseResponse('data: {"type":"message_stop"}\n\n');
  });
  const prompt = 'Your task is to create a detailed summary of the conversation so far.\n\n'
    + 'CRITICAL: Respond with TEXT ONLY. Do NOT call any tools.\n\n'
    + 'Pending Tasks:\n- finish refactor\n\nCurrent Work:\n- reviewing diff';
  await invokeAnthropic(provider.pipelines.anthropicMessages, model, {
    max_tokens: 10,
    metadata: { user_id: JSON.stringify({ device_id: 'dev-1', session_id: 'sess-1' }) },
    messages: [{ role: 'user', content: prompt }],
  }, [], fetcher);

  assertEquals(wire?.get('x-initiator'), 'user');
  assertEquals(wire?.get('x-interaction-type'), 'messages-proxy');
  assertEquals(wire?.get('openai-intent'), 'messages-proxy');
  assertEquals(wire?.get('user-agent'), CLAUDE_AGENT_USER_AGENT);
  assertEquals(wire?.get('copilot-integration-id'), null);
  assertEquals(wire?.get('x-interaction-id'), 'abe633f3-a47a-4758-974e-abe9160daf36');
});
