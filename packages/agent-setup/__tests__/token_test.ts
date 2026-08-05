import { expect, test, vi } from 'vitest';

import { generateAgentSetupToken, isAgentSetupToken } from '../src/token.ts';

test('generateAgentSetupToken encodes all 32 CSPRNG bytes as unpadded base64url', () => {
  const randomSpy = vi.spyOn(crypto, 'getRandomValues').mockImplementation(array => {
    expect(array).toBeInstanceOf(Uint8Array);
    const bytes = array as Uint8Array;
    expect(bytes).toHaveLength(32);
    bytes.forEach((_, index) => { bytes[index] = index; });
    return array;
  });
  try {
    expect(generateAgentSetupToken()).toBe('AAECAwQFBgcICQoLDA0ODxAREhMUFRYXGBkaGxwdHh8');
    expect(randomSpy).toHaveBeenCalledOnce();
  } finally {
    randomSpy.mockRestore();
  }
});

test('isAgentSetupToken accepts only the canonical persisted token shape', () => {
  expect(isAgentSetupToken('a'.repeat(43))).toBe(true);
  expect(isAgentSetupToken('_'.repeat(43))).toBe(true);
  expect(isAgentSetupToken('-'.repeat(43))).toBe(true);
  expect(isAgentSetupToken('a'.repeat(42))).toBe(false);
  expect(isAgentSetupToken('a'.repeat(44))).toBe(false);
  expect(isAgentSetupToken(`${'a'.repeat(42)}+`)).toBe(false);
});
