import { describe, expect, test } from 'vitest';

import { createIRCollector } from '../../src/ir/collector.ts';
import { IRNone } from '../../src/ir/types.ts';

describe('IR accumulator', () => {
  test('stores plain accumulated state without publication metadata', () => {
    const collector = createIRCollector();
    collector.apply({ type: 'operation', operation: 'initialize', path: ['usage'], value: {} });
    collector.apply({ type: 'operation', operation: 'assign', path: ['usage', 'output_tokens_inclusive'], value: 0 });
    expect(collector.value(['usage'])).toEqual({ output_tokens_inclusive: 0 });
  });

  test('enforces static append targets', () => {
    const collector = createIRCollector();
    collector.apply({ type: 'operation', operation: 'initialize', path: ['choices', 0], value: { items: [] } });
    collector.apply({ type: 'operation', operation: 'initialize', path: ['choices', 0, 'items', 0], value: { type: 'message', content: [] } });
    collector.apply({ type: 'operation', operation: 'initialize', path: ['choices', 0, 'items', 0, 'content', 0], value: { type: 'text', text: '' } });
    expect(() => collector.apply({ type: 'operation', operation: 'assign', path: ['choices', 0, 'items', 0, 'content', 0, 'text'], value: 'x' })).toThrow('append target cannot be assigned');
    expect(() => collector.apply({ type: 'operation', operation: 'append', path: ['choices', 0, 'items', 0, 'content', 0, 'text'], value: 1 } as any)).toThrow('append requires a string value');
    collector.apply({ type: 'operation', operation: 'append', path: ['choices', 0, 'items', 0, 'content', 0, 'text'], value: 'x' });
    expect(collector.value(['choices', 0, 'items', 0, 'content', 0, 'text'])).toBe('x');

    collector.apply({ type: 'operation', operation: 'initialize', path: ['choices', 0, 'items', 1], value: { type: 'reasoning', content: [''] } });
    expect(() => collector.apply({ type: 'operation', operation: 'assign', path: ['choices', 0, 'items', 1, 'content', 0], value: 1 })).toThrow('append target cannot be assigned');
  });

  test('rejects undefined and only assigns IRNone to absent fields', () => {
    const collector = createIRCollector();
    expect(() => collector.apply({ type: 'operation', operation: 'assign', path: ['model'], value: IRNone })).toThrow('IRNone is not allowed');
    collector.apply({ type: 'operation', operation: 'initialize', path: ['choices', 0], value: { items: [] } });
    collector.apply({ type: 'operation', operation: 'initialize', path: ['choices', 0, 'items', 0], value: { type: 'function_call', name: 'f', arguments: '' } });
    expect(() => collector.apply({ type: 'operation', operation: 'assign', path: ['choices', 0, 'items', 0, 'call_id'], value: undefined as any })).toThrow('undefined');
    collector.apply({ type: 'operation', operation: 'assign', path: ['choices', 0, 'items', 0, 'call_id'], value: IRNone });
    expect(() => collector.apply({ type: 'operation', operation: 'assign', path: ['choices', 0, 'items', 0, 'call_id'], value: IRNone })).toThrow('absent target');
    expect(() => collector.apply({ type: 'operation', operation: 'assign', path: ['choices', 0, 'refusal'], value: { category: IRNone, explanation: null } as any })).toThrow('assigned directly');
    expect(() => collector.apply({ type: 'operation', operation: 'assign', path: ['choices', 0, 'refusal'], value: { category: undefined, explanation: null } as any })).toThrow('cannot contain undefined');
    expect(() => collector.apply({ type: 'operation', operation: 'initialize', path: ['choices', 0, 'items', 1], value: { type: 'reasoning', summary: [IRNone] } })).toThrow('append target must initialize to an empty string');
  });

  test('enforces append ownership by item type', () => {
    const collector = createIRCollector();
    collector.apply({ type: 'operation', operation: 'initialize', path: ['choices', 0], value: { items: [] } });
    collector.apply({ type: 'operation', operation: 'initialize', path: ['choices', 0, 'items', 0], value: { type: 'function_call', name: 'f', arguments: '' } });
    collector.apply({ type: 'operation', operation: 'initialize', path: ['choices', 0, 'items', 1], value: { type: 'custom_tool_call', name: 'c', input: '' } });
    expect(() => collector.apply({ type: 'operation', operation: 'append', path: ['choices', 0, 'items', 0, 'input'], value: 'x' })).toThrow('append-target path');
    expect(() => collector.apply({ type: 'operation', operation: 'append', path: ['choices', 0, 'items', 1, 'arguments'], value: 'x' })).toThrow('append-target path');
  });

  test('rejects an unallocated choice end', () => {
    const collector = createIRCollector();
    collector.apply({ type: 'operation', operation: 'initialize', path: ['choices', 0], value: { items: [] } });
    expect(() => collector.applyEvent({ type: 'choice_end', choice: 99, finish_reason: 'stop' })).toThrow('does not exist');
  });

  test('rejects operations after part and item end', () => {
    const collector = createIRCollector();
    collector.apply({ type: 'operation', operation: 'initialize', path: ['choices', 0], value: { items: [] } });
    collector.apply({ type: 'operation', operation: 'initialize', path: ['choices', 0, 'items', 0], value: { type: 'message', content: [] } });
    collector.apply({ type: 'operation', operation: 'initialize', path: ['choices', 0, 'items', 0, 'content', 0], value: { type: 'text', text: '' } });
    collector.applyEvent({ type: 'part_end', choice: 0, item: 0, part: 0 });
    expect(() => collector.apply({ type: 'operation', operation: 'append', path: ['choices', 0, 'items', 0, 'content', 0, 'text'], value: 'late' })).toThrow('closed part');
    collector.applyEvent({ type: 'item_end', choice: 0, item: 0 });
    expect(() => collector.apply({ type: 'operation', operation: 'assign', path: ['choices', 0, 'items', 0, 'type'], value: 'message' })).toThrow('closed item');
  });
});
