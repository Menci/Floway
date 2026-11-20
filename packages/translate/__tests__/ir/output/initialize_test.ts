import { expect, test } from 'vitest';

import { createIRCollector } from '../../../src/ir/output/collector.ts';

test('initialize arrays require the exact next index and never replace entries', () => {
  const collector = createIRCollector();
  collector.applyWrite({ type: 'write', kind: 'initialize', path: ['choices', 0], value: { items: [] } });
  expect(() => collector.applyWrite({ type: 'write', kind: 'initialize', path: ['choices', 0], value: { items: [] } })).toThrow();
  for (const index of [-1, 0.5, 2]) expect(() => collector.applyWrite({ type: 'write', kind: 'initialize', path: ['choices', index], value: { items: [] } })).toThrow();
  collector.applyWrite({ type: 'write', kind: 'initialize', path: ['choices', 1], value: { items: [] } });
  expect(collector.state.choices).toHaveLength(2);
});
