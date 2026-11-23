import { test } from 'vitest';

import { fakeCopilotWire, invokeAnthropic } from '../../pipeline-fixture.ts';
import type { AnthropicMessagesUserContentBlock } from '@floway-dev/protocols/anthropic-messages';
import { assertEquals, sseResponse } from '@floway-dev/test-utils';

const toolResult = { type: 'tool_result', tool_use_id: 't_1', content: [{ type: 'text', text: 'result' }] } satisfies AnthropicMessagesUserContentBlock;

const captureInitiator = async (content: AnthropicMessagesUserContentBlock[]) => {
  let initiator: string | null | undefined;
  const { provider, model, fetcher } = await fakeCopilotWire('/v1/messages', 'claude-test', request => {
    initiator = request.headers.get('x-initiator');
    return sseResponse('data: {"type":"message_stop"}\n\n');
  });
  await invokeAnthropic(provider.pipelines.anthropicMessages, model, {
    max_tokens: 10,
    messages: [{ role: 'user', content }],
  }, [], fetcher);
  return initiator;
};

test('Anthropic Messages initiator is user when the last user turn mixes text and tool_result', async () => {
  assertEquals(await captureInitiator([toolResult, { type: 'text', text: 'follow-up question' }]), 'user');
});

test('Anthropic Messages initiator is agent when the last user turn is entirely tool_result blocks', async () => {
  assertEquals(await captureInitiator([toolResult]), 'agent');
});
