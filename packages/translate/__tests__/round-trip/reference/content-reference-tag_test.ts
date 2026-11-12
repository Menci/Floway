import { expect, test } from 'vitest';

import { SidecarTaggedValue } from '../../../src/round-trip/codec.ts';
import { tagContentReferences, untagContentReferences } from '../../../src/round-trip/reference/content-reference-tag.ts';
import { ContentReference } from '../../../src/round-trip/reference/types.ts';

test.each(['text', 'json'] as const)('maps %s references to their transport tag and back', kind => {
  const reference = new ContentReference(kind, [0, [1, 2, 3]]);
  const encoded = tagContentReferences({ reference, ordinary: { kind, parts: [0] } });
  expect(encoded).toEqual({
    reference: new SidecarTaggedValue(kind === 'text' ? 65_536 : 65_537, [0, [1, 2, 3]]),
    ordinary: { kind, parts: [0] },
  });
  expect(untagContentReferences(encoded)).toEqual({ reference, ordinary: { kind, parts: [0] } });
});

test('restores nested tagged values in place and leaves unrelated tags to their owner', () => {
  const nested = { reference: new SidecarTaggedValue(65_536, [0]) };
  const encoded = { nested, unknown: new SidecarTaggedValue(65_540, { opaque: true }) };
  const restored = untagContentReferences(encoded) as typeof encoded & { nested: { reference: ContentReference } };
  expect(restored).toBe(encoded);
  expect(restored.nested).toBe(nested);
  expect(restored.nested.reference).toEqual(new ContentReference('text', [0]));
  expect(restored.unknown).toBe(encoded.unknown);
});

test.each([null, 'reference', [-1], [0.5], [[0, 1]], [[0, 4, 2]], [[0, -1, 2]], [[0, 1, Infinity]]])('rejects malformed thin reference parts %j', parts => {
  expect(() => untagContentReferences(new SidecarTaggedValue(65_536, parts))).toThrow('Thin reference sidecar tag requires reference parts');
});
