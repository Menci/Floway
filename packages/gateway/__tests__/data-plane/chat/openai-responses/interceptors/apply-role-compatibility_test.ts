import { test } from 'vitest';

import { withRoleCompatibilityApplied } from '../../../../../src/data-plane/chat/openai-responses/interceptors/apply-role-compatibility.ts';
import type { OpenAIResponsesInvocation } from '../../../../../src/data-plane/chat/openai-responses/interceptors/types.ts';
import { mockChatGatewayCtx } from '../../../../test-utils/gateway-ctx.ts';
import { doneFrame } from '@floway-dev/protocols/common';
import type { CanonicalOpenAIResponsesInputItem } from '@floway-dev/protocols/openai-responses';
import { eventResult, type FlagId } from '@floway-dev/provider';
import { assertEquals, stubModelCandidate, testTelemetryModelIdentity } from '@floway-dev/test-utils';

const gatewayCtx = mockChatGatewayCtx();
const okEvents = () => Promise.resolve(eventResult((async function* () { yield doneFrame(); })(), testTelemetryModelIdentity));

const applyRoles = async (
  input: CanonicalOpenAIResponsesInputItem[],
  enabledFlags: ReadonlySet<FlagId>,
  targetApi: OpenAIResponsesInvocation['targetApi'] = 'openaiResponses',
): Promise<CanonicalOpenAIResponsesInputItem[]> => {
  const invocation: OpenAIResponsesInvocation = {
    payload: { model: 'test-model', input },
    candidate: stubModelCandidate({ enabledFlags }),
    targetApi,
    headers: new Headers(),
    action: 'generate',
  };
  await withRoleCompatibilityApplied(invocation, gatewayCtx, okEvents);
  return invocation.payload.input;
};

test('applies the system and developer rewrites independently', async () => {
  assertEquals(
    await applyRoles(
      [{ type: 'message', role: 'system', content: 'rules' }],
      new Set(['rewrite-system-to-developer']),
    ),
    [{ type: 'message', role: 'developer', content: 'rules' }],
  );
  assertEquals(
    await applyRoles(
      [{ type: 'message', role: 'developer', content: 'rules' }],
      new Set(['rewrite-developer-to-system']),
    ),
    [{ type: 'message', role: 'system', content: 'rules' }],
  );
});

test('uses non-message items as the boundary before rewriting later system', async () => {
  assertEquals(
    await applyRoles(
      [
        { type: 'message', role: 'system', content: 'base rules' },
        { type: 'reasoning', id: 'rs_1', summary: [] },
        { type: 'message', role: 'system', content: 'inline rules' },
      ],
      new Set(['rewrite-mid-conv-system-to-user']),
    ),
    [
      { type: 'message', role: 'system', content: 'base rules' },
      { type: 'reasoning', id: 'rs_1', summary: [] },
      { type: 'message', role: 'user', content: 'inline rules' },
    ],
  );
});

test('applies overlapping flags in system-to-developer then developer-to-system order', async () => {
  assertEquals(
    await applyRoles(
      [
        { type: 'message', role: 'system', content: 'base rules' },
        { type: 'message', role: 'user', content: 'hello' },
        { type: 'message', role: 'system', content: 'inline rules' },
      ],
      new Set([
        'rewrite-system-to-developer',
        'rewrite-developer-to-system',
        'rewrite-mid-conv-system-to-user',
      ]),
    ),
    [
      { type: 'message', role: 'system', content: 'base rules' },
      { type: 'message', role: 'user', content: 'hello' },
      { type: 'message', role: 'user', content: 'inline rules' },
    ],
  );
});
