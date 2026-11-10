import { test } from 'vitest';

import type { IRInputRequestHeader, IRInputTool, IRInputTurn } from '../../../src/ir/input/types.ts';
import { flattenRequestNames } from '../../../src/protocols/composition/flatten-request.ts';
import { TranslatorInputError } from '../../../src/types.ts';
import { assertThrows, assertEquals } from '@floway-dev/test-utils';

const request = (tools: readonly IRInputTool[]): IRInputRequestHeader => ({ settings: { model: 'm', stream: true }, tools });

test('a grouped declaration keeps its pair when its namespace contains the flatten separator', () => {
  // The flat key is `${namespace}.${name}`, so a namespace that itself contains
  // a dot makes the key ambiguous; the identity must not be read back out of it.
  const flattened = flattenRequestNames(request([{ type: 'function', namespace: 'a.b', name: 'read', parameters: { type: 'object' } }]), []);

  const flatName = flattened.context.flatIdentities.keys().next().value;
  assertEquals(typeof flatName, 'string');
  assertEquals(flattened.context.flatIdentities.get(flatName!), { namespace: 'a.b', name: 'read' });
});

test('a grouped declaration keeps its pair when its name contains the flatten separator', () => {
  const flattened = flattenRequestNames(request([{ type: 'function', namespace: 'files', name: 'read.one', parameters: { type: 'object' } }]), []);

  const flatName = flattened.context.flatIdentities.keys().next().value;
  assertEquals(typeof flatName, 'string');
  assertEquals(flattened.context.flatIdentities.get(flatName!), { namespace: 'files', name: 'read.one' });
});

test('custom declarations are reported under the flat names this wire writes', () => {
  const flattened = flattenRequestNames(request([{ type: 'custom', namespace: 'files', name: 'edit' }]), []);

  // The reader that recognises these calls back sees the wire name, not the
  // client's, so the set has to be stated after flattening.
  assertEquals([...flattened.context.customToolNames], [...flattened.context.flatIdentities.keys()]);
  assertEquals(flattened.request.tools?.[0]?.namespace, undefined);
});

test('a call naming an undeclared group still gets a flat spelling and its pair', () => {
  const turns: IRInputTurn[] = [{
    kind: 'assistant',
    items: [{ type: 'function_call', call_id: 'c1', namespace: 'ghost', name: 'run', arguments: '{}' }],
  }];
  const flattened = flattenRequestNames(request([]), turns);

  const assistantTurn = flattened.turns[0];
  assertEquals(assistantTurn.kind, 'assistant');
  const item = assistantTurn.kind === 'assistant' ? assistantTurn.items[0] : undefined;
  assertEquals(item?.type, 'function_call');
  const flatName = item?.type === 'function_call' ? item.name : undefined;
  assertEquals(typeof flatName, 'string');
  assertEquals(flattened.context.flatIdentities.get(flatName!), { namespace: 'ghost', name: 'run' });
});

test('a selector naming a group the request never declared is a caller error', () => {
  // The mapping is built from the request's own declarations, so a selector that
  // misses names something the caller wrote wrongly — not an internal failure.
  assertThrows(
    () => flattenRequestNames({
      settings: { model: 'm', stream: true },
      tools: [{ type: 'function', namespace: 'files', name: 'read', parameters: { type: 'object' } }],
      tool_choice: { type: 'function', namespace: 'ghost', name: 'run' },
    }, []),
    TranslatorInputError,
    'undeclared grouped tool',
  );
});

test('two different groups spelling the same dotted key are refused rather than merged', () => {
  // `a` + `b.c` and `a.b` + `c` both read `a.b.c`; merging them would hand two
  // declarations one wire name and restore a returned call under the wrong pair.
  assertThrows(
    () => flattenRequestNames(request([
      { type: 'function', namespace: 'a', name: 'b.c', parameters: { type: 'object' } },
      { type: 'function', namespace: 'a.b', name: 'c', parameters: { type: 'object' } },
    ]), []),
    TranslatorInputError,
    'ambiguous grouped callables',
  );
});

test('a selector naming a group this request does not declare is refused', () => {
  // The wire has no grouped declarations to spell, so a dotted selector cannot
  // be resolved; passing it through would force a name the upstream never got.
  assertThrows(
    () => flattenRequestNames({ settings: { model: 'm', stream: true }, tools: [{ type: 'function', name: 'web.run', parameters: { type: 'object' } }], tool_choice: { type: 'function', name: 'run', namespace: 'web' } }, []),
    TranslatorInputError,
  );
});

test('a plain selector passes through untouched', () => {
  const flattened = flattenRequestNames({ settings: { model: 'm', stream: true }, tools: [{ type: 'function', name: 'plain', parameters: { type: 'object' } }], tool_choice: { type: 'function', name: 'plain' } }, []);
  assertEquals(flattened.request.tool_choice, { type: 'function', name: 'plain' });
});

test('a name shared by a function and a custom tool is not reported as freeform', () => {
  // The answer names the call and nothing else, so an ambiguous name cannot be
  // classified; only names that are exclusively freeform are reported.
  const flattened = flattenRequestNames(request([
    { type: 'function', name: 'edit', parameters: { type: 'object' } },
    { type: 'custom', name: 'edit' },
    { type: 'custom', name: 'run' },
  ]), []);
  assertEquals([...flattened.context.customToolNames], ['run']);
});
