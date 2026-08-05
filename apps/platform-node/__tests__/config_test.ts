import { describe, expect, it } from 'vitest';

import { parseNodeListenPort, parseNodeStoragePath } from '../src/config.ts';

describe('parseNodeStoragePath', () => {
  it('normalizes surrounding whitespace on a configured path', () => {
    expect(parseNodeStoragePath('FLOWAY_FILES_DIR', ' ./data/files ')).toBe('./data/files');
  });

  it.each(['', ' ', '\t\n'])('rejects empty configured path %j', value => {
    expect(() => parseNodeStoragePath('FLOWAY_FILES_DIR', value))
      .toThrow('FLOWAY_FILES_DIR must not be empty');
  });
});

describe('parseNodeListenPort', () => {
  it.each([
    ['1', 1],
    ['65535', 65_535],
    [' 8788 ', 8788],
  ] as const)('accepts decimal boundary %j', (raw, expected) => {
    expect(parseNodeListenPort(raw)).toBe(expected);
  });

  it.each(['', ' ', '0', '65536', '-1', '1.5', 'Infinity', '0x2000'])('rejects invalid PORT %j', raw => {
    expect(() => parseNodeListenPort(raw))
      .toThrow('PORT must be a decimal integer between 1 and 65535');
  });
});
