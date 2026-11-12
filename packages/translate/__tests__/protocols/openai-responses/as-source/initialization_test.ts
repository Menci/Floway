import { expect, test } from 'vitest';

import type { IRRecord } from '../../../../src/ir/output/records.ts';
import { collect, iterate } from '../../../shared/iterables.ts';
import { writeOpenAIResponsesEvents } from '../../helpers.ts';

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
  const output = await collect(writeOpenAIResponsesEvents(iterate(records)));
  const serialized = JSON.stringify(output);
  expect(serialized).toContain('real-name');
  expect(serialized).toContain('{}');
});
