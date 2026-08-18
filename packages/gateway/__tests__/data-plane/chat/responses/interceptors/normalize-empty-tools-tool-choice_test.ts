import { test } from 'vitest';

import { withEmptyToolsToolChoiceNormalized } from '../../../../../src/data-plane/chat/responses/interceptors/normalize-empty-tools-tool-choice.ts';
import type { ResponsesInvocation } from '../../../../../src/data-plane/chat/responses/interceptors/types.ts';
import { mockChatGatewayCtx } from '../../../../test-utils/gateway-ctx.ts';
import type { CanonicalResponsesPayload } from '@floway-dev/protocols/responses';
import { eventResult, type FlagId } from '@floway-dev/provider';
import { assertEquals, stubModelCandidate, testTelemetryModelIdentity } from '@floway-dev/test-utils';

const stubCtx = mockChatGatewayCtx();
const okEvents = () => Promise.resolve(eventResult((async function* () {})(), testTelemetryModelIdentity));

const invocation = (
  payload: CanonicalResponsesPayload,
  enabledFlags: ReadonlySet<FlagId> = new Set(['empty-tools-tool-choice-none']),
): ResponsesInvocation => ({
  payload,
  candidate: stubModelCandidate({ enabledFlags }),
  targetApi: 'responses',
  headers: new Headers(),
  action: 'generate',
});

const base = { model: 'm', input: [{ type: 'message' as const, role: 'user' as const, content: 'hi' }] };

test('responses empty tools rewrites tool_choice to none', async () => {
  const input = invocation({ ...base, tools: [], tool_choice: 'auto' });

  await withEmptyToolsToolChoiceNormalized(input, stubCtx, okEvents);

  assertEquals(input.payload.tools, []);
  assertEquals(input.payload.tool_choice, 'none');
});

test('responses rewrite requires the flag and an explicit empty array', async () => {
  const disabled = invocation({ ...base, tools: [], tool_choice: 'auto' }, new Set());
  const missing = invocation({ ...base, tool_choice: 'auto' });
  const present = invocation({
    ...base,
    tools: [{ type: 'function', name: 'x', parameters: {} }],
    tool_choice: 'auto',
  });

  await withEmptyToolsToolChoiceNormalized(disabled, stubCtx, okEvents);
  await withEmptyToolsToolChoiceNormalized(missing, stubCtx, okEvents);
  await withEmptyToolsToolChoiceNormalized(present, stubCtx, okEvents);

  assertEquals(disabled.payload.tool_choice, 'auto');
  assertEquals(missing.payload.tool_choice, 'auto');
  assertEquals(present.payload.tool_choice, 'auto');
});
