import { test } from 'vitest';

import { withEmptyToolsToolChoiceNormalized } from '../../../../../src/data-plane/chat/chat-completions/interceptors/normalize-empty-tools-tool-choice.ts';
import type { ChatCompletionsInvocation } from '../../../../../src/data-plane/chat/chat-completions/interceptors/types.ts';
import { mockChatGatewayCtx } from '../../../../test-utils/gateway-ctx.ts';
import type { ChatCompletionsPayload } from '@floway-dev/protocols/chat-completions';
import { eventResult, type FlagId } from '@floway-dev/provider';
import { assertEquals, stubModelCandidate, testTelemetryModelIdentity } from '@floway-dev/test-utils';

const stubCtx = mockChatGatewayCtx();
const okEvents = () => Promise.resolve(eventResult((async function* () {})(), testTelemetryModelIdentity));

const invocation = (
  payload: ChatCompletionsPayload,
  enabledFlags: ReadonlySet<FlagId> = new Set(['empty-tools-tool-choice-none']),
): ChatCompletionsInvocation => ({
  payload,
  candidate: stubModelCandidate({ enabledFlags }),
  targetApi: 'chat-completions',
  headers: new Headers(),
});

test('empty tools rewrites tool_choice to none', async () => {
  const input = invocation({ model: 'm', messages: [], tools: [], tool_choice: 'auto' });

  await withEmptyToolsToolChoiceNormalized(input, stubCtx, okEvents);

  assertEquals(input.payload.tools, []);
  assertEquals(input.payload.tool_choice, 'none');
});

test('empty tools stays unchanged when the flag is disabled', async () => {
  const input = invocation({ model: 'm', messages: [], tools: [], tool_choice: 'auto' }, new Set());

  await withEmptyToolsToolChoiceNormalized(input, stubCtx, okEvents);

  assertEquals(input.payload.tool_choice, 'auto');
});

test('missing or non-empty tools does not rewrite tool_choice', async () => {
  const missing = invocation({ model: 'm', messages: [], tool_choice: 'auto' });
  const present = invocation({
    model: 'm',
    messages: [],
    tools: [{ type: 'function', function: { name: 'x', parameters: {} } }],
    tool_choice: 'auto',
  });

  await withEmptyToolsToolChoiceNormalized(missing, stubCtx, okEvents);
  await withEmptyToolsToolChoiceNormalized(present, stubCtx, okEvents);

  assertEquals(missing.payload.tool_choice, 'auto');
  assertEquals(present.payload.tool_choice, 'auto');
});
