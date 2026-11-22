import { test } from 'vitest';

import { fakeCopilotWire, invokeAnthropic } from '../../pipeline-fixture.ts';
import { assertEquals, sseResponse } from '@floway-dev/test-utils';

test('Anthropic standard speed is stripped before dispatch', async () => {
  let body: Record<string, unknown> | undefined;
  const { provider, model, fetcher } = await fakeCopilotWire('/v1/messages', 'claude-opus-4.6', async request => {
    body = await request.json() as Record<string, unknown>;
    return sseResponse('data: {"type":"message_stop"}\n\n');
  });
  await invokeAnthropic(provider.pipelines.anthropicMessages, model, {
    max_tokens: 128,
    messages: [{ role: 'user', content: 'hi' }],
    speed: 'standard',
  }, [], fetcher);
  if (body === undefined) throw new Error('Expected the Copilot request');
  assertEquals('speed' in body, false);
});
