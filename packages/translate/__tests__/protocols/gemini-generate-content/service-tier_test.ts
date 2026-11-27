import { expect, test } from 'vitest';

import {
  geminiServiceTierFromInputIR,
  geminiServiceTierFromOutputIR,
  geminiServiceTierToInputIR,
  geminiServiceTierToOutputIR,
} from '../../../src/protocols/gemini-generate-content/service-tier.ts';

test('normalizes Gemini GenerateContent service tiers across input and output IR boundaries', () => {
  expect(geminiServiceTierToInputIR(undefined)).toBeUndefined();
  expect(geminiServiceTierToInputIR('')).toBeUndefined();
  expect(geminiServiceTierToInputIR('standard')).toBe('default');
  expect(geminiServiceTierToInputIR('priority')).toBe('priority');
  expect(geminiServiceTierToInputIR('flex')).toBe('flex');

  expect(geminiServiceTierFromInputIR(undefined)).toBeUndefined();
  expect(geminiServiceTierFromInputIR(null)).toBeUndefined();
  expect(geminiServiceTierFromInputIR('')).toBeUndefined();
  expect(geminiServiceTierFromInputIR('auto')).toBeUndefined();
  expect(geminiServiceTierFromInputIR('default')).toBe('standard');
  expect(geminiServiceTierFromInputIR('fast')).toBe('priority');
  expect(geminiServiceTierFromInputIR('priority')).toBe('priority');
  expect(geminiServiceTierFromInputIR('flex')).toBe('flex');

  expect(geminiServiceTierToOutputIR(undefined)).toBeUndefined();
  expect(geminiServiceTierToOutputIR('')).toBeUndefined();
  expect(geminiServiceTierToOutputIR('standard')).toBe('default');
  expect(geminiServiceTierToOutputIR('priority')).toBe('fast');
  expect(geminiServiceTierToOutputIR('flex')).toBe('flex');

  expect(geminiServiceTierFromOutputIR(undefined)).toBeUndefined();
  expect(geminiServiceTierFromOutputIR('')).toBeUndefined();
  expect(geminiServiceTierFromOutputIR('default')).toBe('standard');
  expect(geminiServiceTierFromOutputIR('fast')).toBe('priority');
  expect(geminiServiceTierFromOutputIR('flex')).toBe('flex');
});
