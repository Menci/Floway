import { expect, test } from 'vitest';

import {
  geminiServiceTierFromInputIR,
  geminiServiceTierFromOutputIR,
  geminiServiceTierToIR,
} from '../../../src/protocols/gemini-generate-content/service-tier.ts';

test('normalizes Gemini GenerateContent service tiers across input and output IR boundaries', () => {
  expect(geminiServiceTierToIR(undefined)).toBeUndefined();
  expect(geminiServiceTierToIR('')).toBeUndefined();
  expect(geminiServiceTierToIR('standard')).toBe('default');
  expect(geminiServiceTierToIR('priority')).toBe('priority');
  expect(geminiServiceTierToIR('flex')).toBe('flex');

  expect(geminiServiceTierFromInputIR(undefined)).toBeUndefined();
  expect(geminiServiceTierFromInputIR(null)).toBeUndefined();
  expect(geminiServiceTierFromInputIR('')).toBeUndefined();
  expect(geminiServiceTierFromInputIR('auto')).toBeUndefined();
  expect(geminiServiceTierFromInputIR('default')).toBe('standard');
  expect(geminiServiceTierFromInputIR('fast')).toBe('priority');
  expect(geminiServiceTierFromInputIR('priority')).toBe('priority');
  expect(geminiServiceTierFromInputIR('flex')).toBe('flex');

  expect(geminiServiceTierFromOutputIR(undefined)).toBeUndefined();
  expect(geminiServiceTierFromOutputIR('')).toBeUndefined();
  expect(geminiServiceTierFromOutputIR('default')).toBe('standard');
  expect(geminiServiceTierFromOutputIR('fast')).toBe('priority');
  expect(geminiServiceTierFromOutputIR('priority')).toBe('priority');
  expect(geminiServiceTierFromOutputIR('flex')).toBe('flex');
});
