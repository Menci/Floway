import { expect, test } from 'vitest';

import { createTestSidecarCodec } from './sidecar-codec.ts';
import { SidecarTaggedValue } from '../../src/round-trip/sidecar-tagged-value.ts';

test.each([65_536, 65_537])('the test codec snapshots application tag %s values and owns every array', async tag => {
  const parts: unknown[] = [0, [1, 2, 3]];
  const reference = new SidecarTaggedValue(tag, parts);
  const codec = createTestSidecarCodec();
  const data = await codec.encode({ reference });
  parts.push(9);
  const range = parts[1];
  if (typeof range !== 'object' || range === null || !Array.isArray(range)) throw new Error('Expected the fixture range');
  range[1] = 99;

  const first = await codec.decode(data);
  if (typeof first !== 'object' || first === null || !('reference' in first) || !(first.reference instanceof SidecarTaggedValue)) throw new Error('Expected a preserved SidecarTaggedValue');
  expect(first.reference).toEqual(new SidecarTaggedValue(tag, [0, [1, 2, 3]]));
  if (!Array.isArray(first.reference.value)) throw new Error('Expected tagged value arrays');
  first.reference.value.push(8);
  const decodedRange = first.reference.value[1];
  if (typeof decodedRange !== 'object' || decodedRange === null || !Array.isArray(decodedRange)) throw new Error('Expected the decoded fixture range');
  decodedRange[2] = 100;
  expect(await codec.decode(data)).toEqual({ reference: new SidecarTaggedValue(tag, [0, [1, 2, 3]]) });
});
