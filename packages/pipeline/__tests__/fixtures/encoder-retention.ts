import { strictEqual } from 'node:assert';

import { createRunEncoder } from '../../src/dump.ts';

const encode = createRunEncoder();
const closedStage = (type: 'stage.leaved' | 'stage.failed', stageId: number): WeakRef<object> => {
  const payload = { text: 'finished stage payload' };
  const ref = new WeakRef(payload);
  encode({ type: 'stage.entered', stageId, name: 'closed', parentStageId: null, facts: { payload } });
  if (type === 'stage.leaved') encode({ type, stageId, facts: { answer: 42 } });
  else encode({ type, stageId, error: new Error('closed with failure') });
  return ref;
};
const returned = closedStage('stage.leaved', 1);
const failed = closedStage('stage.failed', 2);
const collect = (globalThis as typeof globalThis & { gc(): void }).gc;
for (let pass = 0; pass < 20; pass++) {
  await new Promise(resolve => setImmediate(resolve));
  collect();
}
strictEqual(returned.deref(), undefined);
strictEqual(failed.deref(), undefined);
encode({ type: 'stage.entered', stageId: 3, name: 'still live', parentStageId: null, facts: {} });
