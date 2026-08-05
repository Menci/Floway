import { describe, expect, test } from 'vitest';

import { decodeUtf8Source, renderSourceSection } from '../../scripts/source-section.ts';

describe('generated source sections', () => {
  test('renders the bytes between unique ordered boundaries', () => {
    expect(renderSourceSection({ name: 'fragment', file: 'fragment.sh', start: '<start>', end: '<end>', append: '\n' }, 'before<start>body<end>after'))
      .toBe('<start>body\n');
  });

  test.each([
    ['a missing marker', { start: '<missing>' }, 'body', 'does not contain boundary'],
    ['a duplicate marker', { start: '<cut>' }, '<cut>body<cut>', 'more than once'],
    ['reversed markers', { start: '<start>', end: '<end>' }, '<end>body<start>', 'occurs before'],
  ] as const)('rejects %s', (_case, boundaries, source, message) => {
    expect(() => renderSourceSection({ name: 'fragment', file: 'fragment.sh', ...boundaries }, source)).toThrow(message);
  });

  test('decodes valid UTF-8 and rejects replacement-producing byte sequences', () => {
    expect(decodeUtf8Source(Buffer.from('emoji 🚀'), 'valid.sh')).toBe('emoji 🚀');
    expect(() => decodeUtf8Source(Uint8Array.from([0xc3, 0x28]), 'invalid.sh')).toThrow('invalid.sh is not valid UTF-8');
  });
});
