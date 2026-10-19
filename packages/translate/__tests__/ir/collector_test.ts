import { describe, expect, test } from 'vitest';

import { createIRCollector } from '../../src/ir/collector.ts';
import { IRAbsent } from '../../src/ir/types.ts';

describe('IR accumulator', () => {
  test('stores plain accumulated state without publication metadata', () => {
    const collector = createIRCollector();
    collector.apply({ type: 'write', kind: 'initialize', path: ['usage'], value: {} });
    collector.apply({ type: 'write', kind: 'assign', path: ['usage', 'output_tokens_inclusive'], value: 0 });
    expect(collector.value(['usage'])).toEqual({ output_tokens_inclusive: 0 });
  });

  test('enforces static append targets', () => {
    const collector = createIRCollector();
    collector.apply({ type: 'write', kind: 'initialize', path: ['choices', 0], value: { items: [] } });
    collector.apply({ type: 'write', kind: 'initialize', path: ['choices', 0, 'items', 0], value: { type: 'message', content: [] } });
    collector.apply({ type: 'write', kind: 'initialize', path: ['choices', 0, 'items', 0, 'content', 0], value: { type: 'text', text: '' } });
    expect(() => collector.apply({ type: 'write', kind: 'assign', path: ['choices', 0, 'items', 0, 'content', 0, 'text'], value: 'x' })).toThrow('append target cannot be assigned');
    expect(() => collector.apply({ type: 'write', kind: 'append', path: ['choices', 0, 'items', 0, 'content', 0, 'text'], value: 1 } as any)).toThrow('append requires a string value');
    collector.apply({ type: 'write', kind: 'append', path: ['choices', 0, 'items', 0, 'content', 0, 'text'], value: 'x' });
    expect(collector.value(['choices', 0, 'items', 0, 'content', 0, 'text'])).toBe('x');

    collector.apply({ type: 'write', kind: 'initialize', path: ['choices', 0, 'items', 1], value: { type: 'reasoning', content: [''] } });
    expect(() => collector.apply({ type: 'write', kind: 'assign', path: ['choices', 0, 'items', 1, 'content', 0], value: 1 })).toThrow('append target cannot be assigned');
  });

  test('rejects undefined and only assigns IRAbsent to absent fields', () => {
    const collector = createIRCollector();
    expect(() => collector.apply({ type: 'write', kind: 'assign', path: ['model'], value: IRAbsent })).toThrow('IRAbsent is not allowed');
    collector.apply({ type: 'write', kind: 'initialize', path: ['choices', 0], value: { items: [] } });
    collector.apply({ type: 'write', kind: 'initialize', path: ['choices', 0, 'items', 0], value: { type: 'function_call', name: 'f', arguments: '' } });
    expect(() => collector.apply({ type: 'write', kind: 'assign', path: ['choices', 0, 'items', 0, 'call_id'], value: undefined as any })).toThrow('undefined');
    collector.apply({ type: 'write', kind: 'assign', path: ['choices', 0, 'items', 0, 'call_id'], value: IRAbsent });
    expect(() => collector.apply({ type: 'write', kind: 'assign', path: ['choices', 0, 'items', 0, 'call_id'], value: IRAbsent })).toThrow('absent target');
    expect(() => collector.apply({ type: 'write', kind: 'assign', path: ['choices', 0, 'refusal'], value: { category: IRAbsent, explanation: null } as any })).toThrow('assigned directly');
    expect(() => collector.apply({ type: 'write', kind: 'assign', path: ['choices', 0, 'refusal'], value: { category: undefined, explanation: null } as any })).toThrow('cannot contain undefined');
    expect(() => collector.apply({ type: 'write', kind: 'initialize', path: ['choices', 0, 'items', 1], value: { type: 'reasoning', summary: [IRAbsent] } })).toThrow('append target must initialize to an empty string');
  });

  test('enforces append ownership by item type', () => {
    const collector = createIRCollector();
    collector.apply({ type: 'write', kind: 'initialize', path: ['choices', 0], value: { items: [] } });
    collector.apply({ type: 'write', kind: 'initialize', path: ['choices', 0, 'items', 0], value: { type: 'function_call', name: 'f', arguments: '' } });
    collector.apply({ type: 'write', kind: 'initialize', path: ['choices', 0, 'items', 1], value: { type: 'custom_tool_call', name: 'c', input: '' } });
    expect(() => collector.apply({ type: 'write', kind: 'append', path: ['choices', 0, 'items', 0, 'input'], value: 'x' })).toThrow('append-target path');
    expect(() => collector.apply({ type: 'write', kind: 'append', path: ['choices', 0, 'items', 1, 'arguments'], value: 'x' })).toThrow('append-target path');
  });

  test('rejects an unallocated choice end', () => {
    const collector = createIRCollector();
    collector.apply({ type: 'write', kind: 'initialize', path: ['choices', 0], value: { items: [] } });
    expect(() => collector.applyEvent({ type: 'choice_end', choice: 99, finish_reason: 'stop' })).toThrow('does not exist');
  });

  test('rejects operations after part and item end', () => {
    const collector = createIRCollector();
    collector.apply({ type: 'write', kind: 'initialize', path: ['choices', 0], value: { items: [] } });
    collector.apply({ type: 'write', kind: 'initialize', path: ['choices', 0, 'items', 0], value: { type: 'message', content: [] } });
    collector.apply({ type: 'write', kind: 'initialize', path: ['choices', 0, 'items', 0, 'content', 0], value: { type: 'text', text: '' } });
    collector.applyEvent({ type: 'part_end', choice: 0, item: 0, part: 0 });
    expect(() => collector.apply({ type: 'write', kind: 'append', path: ['choices', 0, 'items', 0, 'content', 0, 'text'], value: 'late' })).toThrow('closed part');
    collector.applyEvent({ type: 'item_end', choice: 0, item: 0 });
    expect(() => collector.apply({ type: 'write', kind: 'assign', path: ['choices', 0, 'items', 0, 'type'], value: 'message' })).toThrow('closed item');
  });

  test('rejects ended units that omit required schema fields', () => {
    const incompleteItem = createIRCollector();
    incompleteItem.apply({ type: 'write', kind: 'initialize', path: ['choices', 0], value: { items: [] } });
    incompleteItem.apply({ type: 'write', kind: 'initialize', path: ['choices', 0, 'items', 0], value: { type: 'function_call' } });
    expect(() => incompleteItem.applyEvent({ type: 'item_end', choice: 0, item: 0 })).toThrow('requires field name');

    const incompleteMessage = createIRCollector();
    incompleteMessage.apply({ type: 'write', kind: 'initialize', path: ['choices', 0], value: { items: [] } });
    incompleteMessage.apply({ type: 'write', kind: 'initialize', path: ['choices', 0, 'items', 0], value: { type: 'message' } });
    expect(() => incompleteMessage.applyEvent({ type: 'item_end', choice: 0, item: 0 })).toThrow('requires field content');

    const incompleteChoice = createIRCollector();
    incompleteChoice.apply({ type: 'write', kind: 'initialize', path: ['choices', 0], value: {} });
    expect(() => incompleteChoice.applyEvent({ type: 'choice_end', choice: 0, finish_reason: 'stop' })).toThrow('requires field items');
  });
});
