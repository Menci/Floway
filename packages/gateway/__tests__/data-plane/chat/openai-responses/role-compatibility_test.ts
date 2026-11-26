import { test } from 'vitest';

import { observeResponsesRequest } from './request-stage.ts';
import { applyOpenAIResponsesRoleCompatibility } from '../../../../src/data-plane/chat/openai-responses/role-compatibility.ts';
import type { CanonicalOpenAIResponsesInputItem } from '@floway-dev/protocols/openai-responses';
import type { FlagId } from '@floway-dev/provider';
import { assertEquals } from '@floway-dev/test-utils';

const applyRoles = async (input: CanonicalOpenAIResponsesInputItem[], flags: ReadonlySet<FlagId>) =>
  (await observeResponsesRequest(applyOpenAIResponsesRoleCompatibility, { model: 'test-model', input }, flags)).seen?.input;

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
