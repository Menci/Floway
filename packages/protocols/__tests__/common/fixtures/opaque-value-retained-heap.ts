import assert from 'node:assert/strict';

import { encodeOpaqueValue } from '../../../src/common/opaque-value.ts';

if (globalThis.gc === undefined) throw new Error('The retained-heap fixture requires --expose-gc');

const expected = Array.from({ length: 64 }, (_, index) => `${index}:`.padEnd(6144, 'a'));
const inputs = expected.map(value => Buffer.from(value, 'utf16le').swap16());
for (const input of inputs) encodeOpaqueValue(input, 'raw');

globalThis.gc();
const baseline = process.memoryUsage().heapUsed;
const retained = inputs.map(input => encodeOpaqueValue(input, 'raw'));
globalThis.gc();
const retainedHeapBytes = process.memoryUsage().heapUsed - baseline;

// Comparing or serializing the strings before sampling can flatten V8 ropes,
// hiding the representation retained while later affinity blocks are decoded.
assert.deepEqual(retained, expected);
process.stdout.write(JSON.stringify({
  count: retained.length,
  codeUnits: retained.reduce((sum, value) => sum + value.length, 0),
  retainedHeapBytes,
}));
