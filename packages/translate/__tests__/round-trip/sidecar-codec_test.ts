import { expect, test } from 'vitest';

import { createTestSidecarCodec } from './sidecar-codec.ts';
import { ThinReference, type ReferencePart } from '../../src/round-trip/thin/reference.ts';

test.each(['text', 'json'] as const)('the test codec snapshots %s references and owns every parts array', async restoration => {
  const parts: ReferencePart[] = [0, [1, 2, 3]];
  const reference = new ThinReference(restoration, parts);
  const codec = createTestSidecarCodec();
  const data = await codec.encode({ reference });
  parts.push(9);
  const range = parts[1];
  if (typeof range === 'number') throw new Error('Expected the fixture range');
  range[1] = 99;

  const first = await codec.decode(data);
  if (typeof first !== 'object' || first === null || !('reference' in first) || !(first.reference instanceof ThinReference)) throw new Error('Expected a preserved ThinReference');
  expect(first.reference).toEqual(new ThinReference(restoration, [0, [1, 2, 3]]));
  first.reference.parts.push(8);
  const decodedRange = first.reference.parts[1];
  if (typeof decodedRange === 'number') throw new Error('Expected the decoded fixture range');
  decodedRange[2] = 100;
  expect(await codec.decode(data)).toEqual({ reference: new ThinReference(restoration, [0, [1, 2, 3]]) });
});
