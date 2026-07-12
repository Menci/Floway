import { test } from 'vitest';

import {
  createStoredResponsesItemId,
  createTemporaryResponsesItemId,
  hashResponsesItemContent,
  isStoredResponsesItemId,
} from './format.ts';
import { assert, assertFalse, assertThrows } from '@floway-dev/test-utils';

const explicitPrefixes = [
  ['message', 'msg'],
  ['reasoning', 'rs'],
  ['web_search_call', 'ws'],
  ['function_call', 'fc'],
  ['function_call_output', 'fco'],
  ['custom_tool_call', 'ctc'],
  ['custom_tool_call_output', 'ctco'],
  ['file_search_call', 'fs'],
  ['computer_call', 'cc'],
  ['computer_call_output', 'cco'],
  ['tool_search_call', 'ts'],
  ['tool_search_output', 'tso'],
  ['compaction', 'cmp'],
  ['compaction_summary', 'cmp'],
  ['image_generation_call', 'ig'],
  ['code_interpreter_call', 'ci'],
  ['local_shell_call', 'lsh'],
  ['local_shell_call_output', 'lsho'],
  ['shell_call', 'sh'],
  ['shell_call_output', 'sho'],
  ['apply_patch_call', 'ap'],
  ['apply_patch_call_output', 'apo'],
  ['mcp_call', 'mcp'],
  ['mcp_list_tools', 'mcpl'],
  ['mcp_approval_request', 'mcpar'],
  ['mcp_approval_response', 'mcpa'],
  ['program', 'pg'],
  ['program_output', 'pgo'],
] as const;

test('accepts the design-spec examples (CRC32 over only the body segment)', () => {
  assert(isStoredResponsesItemId('msg_z1mVjw_0xVvS8c_KjD1sBkZk5qbdA'));
  assert(isStoredResponsesItemId('rs_mFBDiA_Lh1uXb7nD_bQb4I1CUYH2w'));
  assert(isStoredResponsesItemId('ws_WGRXTA_sVlhxg6BAV0BUzj0KkWSqA'));
});

test('rejects malformed public ids before SQL lookup', () => {
  assertFalse(isStoredResponsesItemId('msg_AAAAAA_0xVvS8c_KjD1sBkZk5qbdA'));
  assertFalse(isStoredResponsesItemId('itm_z1mVjw_0xVvS8c_KjD1sBkZk5qbdA'));
  assertFalse(isStoredResponsesItemId('msg_z1mVjw_short'));
  assertFalse(isStoredResponsesItemId('msg_z1mVjw_0xVvS8c.KjD1sBkZk5qbdA'));
});

test('generates a valid stored id for every explicit supported item type', () => {
  for (const [itemType, prefix] of explicitPrefixes) {
    const id = createStoredResponsesItemId(itemType);
    assert(isStoredResponsesItemId(id), `expected ${id} to be a valid stored id`);
    assert(id.startsWith(`${prefix}_`), `expected ${id} to use prefix ${prefix}`);
  }
});

test('throws for unknown item types instead of using a generic fallback prefix', () => {
  assertThrows(() => createStoredResponsesItemId('unknown_item'), TypeError, 'Unknown Responses item type');
  assertThrows(() => createTemporaryResponsesItemId('unknown_item'), TypeError, 'Unknown Responses item type');
});

// `compaction_trigger` is intentionally absent from the prefix map. It is a
// per-request control signal (payload-free, idless, never re-sent on later
// turns) that is filtered out in `stageInputItem`, so no stored row is ever
// minted for it. The throw here is the regression test: it pins the invariant
// that nobody adds a prefix back without also re-introducing a use case.
test('rejects compaction_trigger — a control signal that should never be stored', () => {
  assertThrows(() => createStoredResponsesItemId('compaction_trigger'), TypeError, 'Unknown Responses item type');
  assertThrows(() => createTemporaryResponsesItemId('compaction_trigger'), TypeError, 'Unknown Responses item type');
});

// `additional_tools` is a turn-scoped developer directive the client re-sends
// every turn (no cross-turn persistence value). `stageInputItem` filters it
// out before minting a stored row, so — like `compaction_trigger` — no prefix
// exists. The throw pins the invariant.
test('rejects additional_tools — a turn-scoped directive that should never be stored', () => {
  assertThrows(() => createStoredResponsesItemId('additional_tools'), TypeError, 'Unknown Responses item type');
  assertThrows(() => createTemporaryResponsesItemId('additional_tools'), TypeError, 'Unknown Responses item type');
});

test('successive stored ids for the same item type collide-free under random body', () => {
  const seen = new Set<string>();
  for (let i = 0; i < 1024; i += 1) {
    const id = createStoredResponsesItemId('message');
    assertFalse(seen.has(id), `random body collided after ${i} draws`);
    seen.add(id);
    assert(isStoredResponsesItemId(id));
  }
});

test('temporary ids use the item prefix without becoming stored ids', () => {
  const temporary = createTemporaryResponsesItemId('reasoning');
  assert(/^rs_tmp_[A-Za-z0-9_-]{22}$/.test(temporary), temporary);
  assertFalse(isStoredResponsesItemId(temporary));
});

test('input content hashing includes the item id', async () => {
  const first = await hashResponsesItemContent({ type: 'message', id: 'msg_a', role: 'user', content: 'same' });
  const second = await hashResponsesItemContent({ type: 'message', id: 'msg_b', role: 'user', content: 'same' });

  assertFalse(first === second);
});
