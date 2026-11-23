import { test } from 'vitest';

import { driveResponsesStage } from './drive.ts';
import { applyRoleCompatibility } from '../../../../../src/data-plane/chat/openai-responses/stages/apply-role-compatibility.ts';
import type { CanonicalOpenAIResponsesInputItem } from '@floway-dev/protocols/openai-responses';
import type { FlagId } from '@floway-dev/provider';
import { assert, assertEquals } from '@floway-dev/test-utils';

const applyRoles = async (input: CanonicalOpenAIResponsesInputItem[], enabledFlags: ReadonlySet<FlagId>) => {
  const { seen, done } = await driveResponsesStage(applyRoleCompatibility, { model: 'test-model', input }, { enabledFlags, wire: true });
  assert(seen !== undefined);
  assertEquals(await done, { ok: true });
  return seen.input;
};

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
