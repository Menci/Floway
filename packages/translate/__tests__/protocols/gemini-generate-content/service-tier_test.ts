import { expect, test } from 'vitest';

import {
  generateContentServiceTierFromIR,
  generateContentServiceTierToIR,
} from '../../../src/protocols/gemini-generate-content/service-tier.ts';

test('normalizes GenerateContent service tiers across input and output IR boundaries', () => {
  expect(generateContentServiceTierToIR(undefined)).toBeUndefined();
  expect(generateContentServiceTierToIR('')).toBeUndefined();
  expect(generateContentServiceTierToIR('standard')).toBe('default');
  expect(generateContentServiceTierToIR('flex')).toBe('flex');

  expect(generateContentServiceTierFromIR(null)).toBeUndefined();
  expect(generateContentServiceTierFromIR('')).toBeUndefined();
  expect(generateContentServiceTierFromIR('default')).toBe('standard');
  expect(generateContentServiceTierFromIR('fast')).toBe('priority');
  expect(generateContentServiceTierFromIR('flex')).toBe('flex');
});
