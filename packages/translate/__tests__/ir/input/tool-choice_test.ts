import { test } from 'vitest';

import { irInputToolChoiceForTools } from '../../../src/ir/input/tool-choice.ts';
import type { IRInputTool, IRInputToolChoice } from '../../../src/ir/input/types.ts';
import { assertEquals } from '@floway-dev/test-utils';

const read: IRInputTool = { type: 'function', name: 'read' };
const charge: IRInputTool = { type: 'function', name: 'charge' };
const edit: IRInputTool = { type: 'custom', name: 'edit' };
const tools: IRInputTool[] = [read, charge, edit];

test('a declared request states its choice as given', () => {
  for (const choice of ['auto', 'none', 'required', { type: 'function', name: 'read' }] as const satisfies readonly IRInputToolChoice[]) {
    assertEquals(irInputToolChoiceForTools(choice, tools), choice);
  }
});

test('a mode still means something without declarations', () => {
  assertEquals(irInputToolChoiceForTools('auto', undefined), 'auto');
  assertEquals(irInputToolChoiceForTools('none', undefined), 'none');
});

test('a choice demanding a callable is not stated without declarations', () => {
  assertEquals(irInputToolChoiceForTools('required', undefined), undefined);
  assertEquals(irInputToolChoiceForTools({ type: 'function', name: 'read' }, []), undefined);
});

test('an empty subset states none rather than letting auto reach for a tool', () => {
  assertEquals(irInputToolChoiceForTools({ type: 'allowed_tools', mode: 'auto', tools: [] }, []), 'none');
  assertEquals(irInputToolChoiceForTools({ type: 'allowed_tools', mode: 'required', tools: [] }, []), undefined);
});

test('an absent selector stays absent', () => {
  assertEquals(irInputToolChoiceForTools(undefined, tools), undefined);
});
