import { expect, test } from 'vitest';

import {
  geminiServiceTierFromIR,
  geminiServiceTierToIR,
} from '../../../src/protocols/gemini-generate-content/service-tier.ts';

test('normalizes GenerateContent service tiers across input and output IR boundaries', () => {
  expect(geminiServiceTierToIR(undefined)).toBeUndefined();
  expect(geminiServiceTierToIR('')).toBeUndefined();
  expect(geminiServiceTierToIR('standard')).toBe('default');
  expect(geminiServiceTierToIR('priority')).toBe('priority');
  expect(geminiServiceTierToIR('flex')).toBe('flex');

  expect(geminiServiceTierFromIR(undefined)).toBeUndefined();
  expect(geminiServiceTierFromIR(null)).toBeUndefined();
  expect(geminiServiceTierFromIR('')).toBeUndefined();
  expect(geminiServiceTierFromIR('default')).toBe('standard');
  expect(geminiServiceTierFromIR('fast')).toBe('priority');
  expect(geminiServiceTierFromIR('priority')).toBe('priority');
  expect(geminiServiceTierFromIR('flex')).toBe('flex');
});
