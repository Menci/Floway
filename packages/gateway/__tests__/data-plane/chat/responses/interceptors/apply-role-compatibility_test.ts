import { test } from 'vitest';

import { withRoleCompatibilityApplied } from '../../../../../src/data-plane/chat/responses/interceptors/apply-role-compatibility.ts';
import type { ResponsesInvocation } from '../../../../../src/data-plane/chat/responses/interceptors/types.ts';
import { mockChatGatewayCtx } from '../../../../test-utils/gateway-ctx.ts';
import { doneFrame } from '@floway-dev/protocols/common';
import type { ResponsesInputItem } from '@floway-dev/protocols/responses';
import { eventResult, type FlagId } from '@floway-dev/provider';
import { assert, assertEquals, stubModelCandidate, testTelemetryModelIdentity } from '@floway-dev/test-utils';

const gatewayCtx = mockChatGatewayCtx();
const okEvents = () => Promise.resolve(eventResult((async function* () { yield doneFrame(); })(), testTelemetryModelIdentity));

const applyRoles = async (
  input: ResponsesInputItem[],
  enabledFlags: ReadonlySet<FlagId>,
  targetApi: ResponsesInvocation['targetApi'] = 'responses',
): Promise<ResponsesInputItem[]> => {
  const invocation: ResponsesInvocation = {
    payload: { model: 'test-model', input },
    candidate: stubModelCandidate({ enabledFlags }),
    targetApi,
    headers: new Headers(),
    action: 'generate',
  };
  await withRoleCompatibilityApplied(invocation, gatewayCtx, okEvents);
  return invocation.payload.input;
};

test('leaves roles unchanged without flags or at a translated target', async () => {
  const input: ResponsesInputItem[] = [
    { type: 'message', role: 'system', content: 'rules' },
    { type: 'message', role: 'developer', content: 'developer rules' },
  ];

  assertEquals(await applyRoles(input, new Set()), input);
  assertEquals(await applyRoles(input, new Set(['rewrite-system-to-developer']), 'chat-completions'), input);
});

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

test('keeps a leading-only system run and an empty input unchanged', async () => {
  const leading: ResponsesInputItem[] = [
    { type: 'message', role: 'system', content: 'base A' },
    { type: 'message', role: 'system', content: 'base B' },
  ];
  assertEquals(await applyRoles(leading, new Set(['rewrite-mid-conv-system-to-user'])), leading);
  assertEquals(await applyRoles([], new Set(['rewrite-mid-conv-system-to-user'])), []);
});

test('preserves multipart content identity when rewriting a mid-conversation system message', async () => {
  const content = [
    { type: 'input_text' as const, text: 'one' },
    { type: 'input_text' as const, text: 'two' },
  ];
  const result = await applyRoles(
    [
      { type: 'message', role: 'user', content: 'hello' },
      { type: 'message', role: 'system', content },
    ],
    new Set(['rewrite-mid-conv-system-to-user']),
  );
  assertEquals(result, [
    { type: 'message', role: 'user', content: 'hello' },
    { type: 'message', role: 'user', content },
  ]);
  const rewritten = result[1];
  assert(rewritten?.type === 'message' && rewritten.content === content);
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
