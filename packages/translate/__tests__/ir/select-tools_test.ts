import { test } from 'vitest';

import { irInputToolChoiceForTools, irInputToolsForChoice } from '../../src/ir/input/select-tools.ts';
import type { IRInputTool, IRInputToolChoice } from '../../src/ir/input/types.ts';
import { assertEquals } from '@floway-dev/test-utils';

const read: IRInputTool = { type: 'function', name: 'read' };
const charge: IRInputTool = { type: 'function', name: 'charge' };
const edit: IRInputTool = { type: 'custom', name: 'edit' };
const tools: IRInputTool[] = [read, charge, edit];

test('only a subset selector narrows the declarations', () => {
  assertEquals(irInputToolsForChoice(tools, undefined), tools);
  assertEquals(irInputToolsForChoice(tools, 'auto'), tools);
  assertEquals(irInputToolsForChoice(tools, 'none'), tools);
  assertEquals(irInputToolsForChoice(tools, 'required'), tools);
  assertEquals(irInputToolsForChoice(tools, { type: 'function', name: 'read' }), tools);
});

test('a subset selector keeps the declarations it names', () => {
  assertEquals(
    irInputToolsForChoice(tools, { type: 'allowed_tools', mode: 'auto', tools: [{ type: 'custom', name: 'edit' }, { type: 'function', name: 'read' }] }),
    [read, edit],
  );
});

test('a subset selector distinguishes a function from a custom tool sharing a name', () => {
  const both: IRInputTool[] = [{ type: 'function', name: 'read' }, { type: 'custom', name: 'read' }];
  assertEquals(
    irInputToolsForChoice(both, { type: 'allowed_tools', mode: 'required', tools: [{ type: 'custom', name: 'read' }] }),
    [both[1]],
  );
});

test('a subset selecting nothing leaves no declaration', () => {
  assertEquals(irInputToolsForChoice(tools, { type: 'allowed_tools', mode: 'auto', tools: [] }), []);
});

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
