import { expect, test } from 'vitest';

import { collect, iterate, openaiResponsesFromIR } from './helpers.ts';
import { createIRCollector } from '../../src/ir/collector.ts';
import { createIRBuilder, type IRRecord } from '../../src/ir/stream.ts';

test('initialize carries real required fields while append targets start empty', async () => {
  const records: IRRecord[] = [
    { type: 'write', kind: 'initialize', path: ['choices', 0], value: { items: [] } },
    { type: 'write', kind: 'assign', path: ['model'], value: 'model' },
    { type: 'start', id: 'source' },
    { type: 'write', kind: 'initialize', path: ['choices', 0, 'items', 0], value: { type: 'function_call', call_id: 'call', name: 'real-name', arguments: '' } },
    { type: 'write', kind: 'append', path: ['choices', 0, 'items', 0, 'arguments'], value: '{}' },
    { type: 'item_end', choice: 0, item: 0 },
    { type: 'choice_end', choice: 0, finish_reason: 'tool_calls' },
    { type: 'finish', status: 'completed' },
  ];
  const output = await collect(openaiResponsesFromIR(iterate(records)));
  const serialized = JSON.stringify(output);
  expect(serialized).toContain('real-name');
  expect(serialized).toContain('{}');
});

test('initialize arrays require the exact next index and never replace entries', () => {
  const collector = createIRCollector();
  collector.apply({ type: 'write', kind: 'initialize', path: ['choices', 0], value: { items: [] } });
  expect(() => collector.apply({ type: 'write', kind: 'initialize', path: ['choices', 0], value: { items: [] } })).toThrow('absent target');
  for (const index of [-1, 0.5, 2]) expect(() => collector.apply({ type: 'write', kind: 'initialize', path: ['choices', index], value: { items: [] } })).toThrow();
  collector.apply({ type: 'write', kind: 'initialize', path: ['choices', 1], value: { items: [] } });
  expect(collector.state.choices).toHaveLength(2);
});

test('append accepts only statically declared string fields', () => {
  const collector = createIRCollector();
  collector.apply({ type: 'write', kind: 'initialize', path: ['choices', 0], value: { items: [] } });
  collector.apply({ type: 'write', kind: 'initialize', path: ['choices', 0, 'items', 0], value: { type: 'message', content: [] } });
  collector.apply({ type: 'write', kind: 'initialize', path: ['choices', 0, 'items', 0, 'content', 0], value: { type: 'text', text: '' } });
  expect(() => collector.apply({ type: 'write', kind: 'append', path: ['model'], value: 'x' })).toThrow('append-target path');
  collector.apply({ type: 'write', kind: 'append', path: ['choices', 0, 'items', 0, 'content', 0, 'text'], value: 'x' });
  expect(collector.value(['choices', 0, 'items', 0, 'content', 0, 'text'])).toBe('x');
});

test('builder initializes items without separate start events', () => {
  const builder = createIRBuilder();
  builder.item(0, { type: 'message', content: [] });
  expect(builder.drain()).toEqual([
    { type: 'write', kind: 'initialize', path: ['choices', 0], value: { items: [] } },
    { type: 'write', kind: 'initialize', path: ['choices', 0, 'items', 0], value: { type: 'message', content: [] } },
  ]);
});
