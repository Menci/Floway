import { test } from 'vitest';

import { withEmptyToolsToolChoiceNormalized } from '../../../../../src/data-plane/chat/messages/interceptors/normalize-empty-tools-tool-choice.ts';
import type { MessagesInvocation } from '../../../../../src/data-plane/chat/messages/interceptors/types.ts';
import { mockChatGatewayCtx } from '../../../../test-utils/gateway-ctx.ts';
import type { MessagesPayload } from '@floway-dev/protocols/messages';
import { type FlagId } from '@floway-dev/provider';
import { assertEquals, stubModelCandidate } from '@floway-dev/test-utils';

const stubCtx = mockChatGatewayCtx();
const okResponse = () => Promise.resolve(new Response());

const invocation = (
  payload: MessagesPayload,
  enabledFlags: ReadonlySet<FlagId> = new Set(['empty-tools-tool-choice-none']),
): MessagesInvocation => ({
  payload,
  candidate: stubModelCandidate({ enabledFlags }),
  targetApi: 'messages',
  headers: new Headers(),
});

const base = { model: 'm', messages: [], max_tokens: 1 };

test('messages empty tools rewrites tool_choice to native none', async () => {
  const input = invocation({ ...base, tools: [], tool_choice: { type: 'auto' } });

  await withEmptyToolsToolChoiceNormalized(input, stubCtx, okResponse);

  assertEquals(input.payload.tools, []);
  assertEquals(input.payload.tool_choice, { type: 'none' });
});

test('messages rewrite requires the flag and an explicit empty array', async () => {
  const disabled = invocation({ ...base, tools: [], tool_choice: { type: 'auto' } }, new Set());
  const missing = invocation({ ...base, tool_choice: { type: 'auto' } });
  const present = invocation({
    ...base,
    tools: [{ name: 'x', description: 'x', input_schema: { type: 'object' } }],
    tool_choice: { type: 'auto' },
  });

  await withEmptyToolsToolChoiceNormalized(disabled, stubCtx, okResponse);
  await withEmptyToolsToolChoiceNormalized(missing, stubCtx, okResponse);
  await withEmptyToolsToolChoiceNormalized(present, stubCtx, okResponse);

  assertEquals(disabled.payload.tool_choice, { type: 'auto' });
  assertEquals(missing.payload.tool_choice, { type: 'auto' });
  assertEquals(present.payload.tool_choice, { type: 'auto' });
});
