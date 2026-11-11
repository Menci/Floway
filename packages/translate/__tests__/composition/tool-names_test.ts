import { test } from 'vitest';

import { allocateToolNames } from '../../src/composition/tool-names.ts';
import type { IRInputRequestHeader, IRInputTool, IRInputTurn } from '../../src/ir/input/types.ts';
import { TranslateInputException } from '../../src/types.ts';
import { assertThrows, assertEquals } from '@floway-dev/test-utils';

const request = (tools: readonly IRInputTool[]): IRInputRequestHeader => ({ settings: { model: 'm', stream: true }, tools });

test('a grouped declaration keeps its pair when its namespace contains the flatten separator', () => {
  // The flat key is `${namespace}.${name}`, so a namespace that itself contains
  // a dot makes the key ambiguous; the identity must not be read back out of it.
  const flattened = allocateToolNames(request([{ type: 'function', namespace: 'a.b', name: 'read', parameters: { type: 'object' } }]), []);

  const flatName = flattened.context.originalToolNames.keys().next().value;
  assertEquals(typeof flatName, 'string');
  assertEquals(flattened.context.originalToolNames.get(flatName!), { namespace: 'a.b', name: 'read' });
});

test('a grouped declaration keeps its pair when its name contains the flatten separator', () => {
  const flattened = allocateToolNames(request([{ type: 'function', namespace: 'files', name: 'read.one', parameters: { type: 'object' } }]), []);

  const flatName = flattened.context.originalToolNames.keys().next().value;
  assertEquals(typeof flatName, 'string');
  assertEquals(flattened.context.originalToolNames.get(flatName!), { namespace: 'files', name: 'read.one' });
});

test('custom declarations are reported under the flat names this wire writes', () => {
  const flattened = allocateToolNames(request([{ type: 'custom', namespace: 'files', name: 'edit' }]), []);

  // The reader that recognises these calls back sees the wire name, not the
  // client's, so the set has to be stated after flattening.
  assertEquals([...flattened.context.customToolNames], [...flattened.context.originalToolNames.keys()]);
  assertEquals(flattened.request.tools?.[0]?.namespace, undefined);
});

test('a call naming an undeclared group still gets a flat spelling and its pair', () => {
  const turns: IRInputTurn[] = [{
    kind: 'assistant',
    items: [{ type: 'function_call', call_id: 'c1', namespace: 'ghost', name: 'run', arguments: '{}' }],
  }];
  const flattened = allocateToolNames(request([]), turns);

  const assistantTurn = flattened.turns[0];
  assertEquals(assistantTurn.kind, 'assistant');
  const item = assistantTurn.kind === 'assistant' ? assistantTurn.items[0] : undefined;
  assertEquals(item?.type, 'function_call');
  const flatName = item?.type === 'function_call' ? item.name : undefined;
  assertEquals(typeof flatName, 'string');
  assertEquals(flattened.context.originalToolNames.get(flatName!), { namespace: 'ghost', name: 'run' });
});

test('a selector naming a group the request never declared is a caller error', () => {
  // The mapping is built from the request's own declarations, so a selector that
  // misses names something the caller wrote wrongly — not an internal failure.
  assertThrows(
    () => allocateToolNames({
      settings: { model: 'm', stream: true },
      tools: [{ type: 'function', namespace: 'files', name: 'read', parameters: { type: 'object' } }],
      tool_choice: { type: 'function', namespace: 'ghost', name: 'run' },
    }, []),
    TranslateInputException,
    'undeclared grouped tool',
  );
});

test('two different groups spelling the same dotted key are refused rather than merged', () => {
  // `a` + `b.c` and `a.b` + `c` both read `a.b.c`; merging them would hand two
  // declarations one wire name and restore a returned call under the wrong pair.
  assertThrows(
    () => allocateToolNames(request([
      { type: 'function', namespace: 'a', name: 'b.c', parameters: { type: 'object' } },
      { type: 'function', namespace: 'a.b', name: 'c', parameters: { type: 'object' } },
    ]), []),
    TranslateInputException,
    'ambiguous grouped callables',
  );
});

test('a selector naming a group this request does not declare is refused', () => {
  // The wire has no grouped declarations to spell, so a dotted selector cannot
  // be resolved; passing it through would force a name the upstream never got.
  assertThrows(
    () => allocateToolNames({ settings: { model: 'm', stream: true }, tools: [{ type: 'function', name: 'web.run', parameters: { type: 'object' } }], tool_choice: { type: 'function', name: 'run', namespace: 'web' } }, []),
    TranslateInputException,
  );
});

test('a plain selector passes through untouched', () => {
  const flattened = allocateToolNames({ settings: { model: 'm', stream: true }, tools: [{ type: 'function', name: 'plain', parameters: { type: 'object' } }], tool_choice: { type: 'function', name: 'plain' } }, []);
  assertEquals(flattened.request.tool_choice, { type: 'function', name: 'plain' });
});

test.each([undefined, 'files'])('allocates distinct names per callable kind in namespace %s independently of selection', namespace => {
  const tools: IRInputTool[] = [
    { type: 'function', namespace, name: 'edit', parameters: { type: 'object' } },
    { type: 'custom', namespace, name: 'edit' },
    { type: 'function', name: 'edit_2', parameters: { type: 'object' } },
  ];
  const turns: IRInputTurn[] = [{
    kind: 'assistant', items: [
      { type: 'function_call', namespace, name: 'edit', call_id: 'f', arguments: '{}' },
      { type: 'custom_tool_call', namespace, name: 'edit', call_id: 'c', input: 'raw' },
      { type: 'custom_tool_call', namespace, name: 'edit', call_id: 'c2', input: 'again' },
    ],
  }];
  const baseline = allocateToolNames({ ...request(tools), tool_choice: 'auto' }, turns);
  const selected = allocateToolNames({ ...request(tools), tool_choice: { type: 'allowed_tools', mode: 'required', tools: [{ type: 'custom', namespace, name: 'edit' }] } }, turns);
  const first = namespace === undefined ? 'edit' : 'files_edit';
  const second = namespace === undefined ? 'edit_3' : 'files_edit_2';
  assertEquals(baseline.request.tools?.map(tool => tool.name), [first, second, 'edit_2']);
  assertEquals(selected.request.tools, baseline.request.tools);
  assertEquals(selected.turns, baseline.turns);
  assertEquals(selected.request.tool_choice, { type: 'allowed_tools', mode: 'required', tools: [{ type: 'custom', name: second }] });
  const assistant = selected.turns[0];
  assertEquals(assistant.kind === 'assistant' ? assistant.items.map(item => 'name' in item ? item.name : undefined) : [], [first, second, second]);
  assertEquals([...selected.context.customToolNames], [second]);
  assertEquals(selected.context.originalToolNames.get(second), { name: 'edit', ...(namespace === undefined ? {} : { namespace }) });
});
