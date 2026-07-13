import { expect, test } from 'vitest';

import { isModelConfigValid } from './modelValidation.ts';
import type { UpstreamModelConfig } from '../../api/types.ts';

const config = (overrides: Partial<UpstreamModelConfig> = {}): UpstreamModelConfig => ({
  upstreamModelId: 'model',
  kind: 'chat',
  endpoints: { chatCompletions: {} },
  ...overrides,
});

test('model config validation covers pricing without mounting an editor', () => {
  expect(isModelConfigValid(config())).toBe(true);
  expect(isModelConfigValid(config({ pricing: { entries: [] } }))).toBe(false);
  expect(isModelConfigValid(config({ pricing: { entries: [{ rates: {} }] } }))).toBe(false);
  expect(isModelConfigValid(config({ pricing: { entries: [{ rates: { input: 1 } }] } }))).toBe(true);
});

test('model config validation covers reasoning effort and budget invariants', () => {
  expect(isModelConfigValid(config({ chat: { reasoning: { effort: { supported: [], default: '' } } } }))).toBe(false);
  expect(isModelConfigValid(config({ chat: { reasoning: { effort: { supported: ['high'], default: 'low' } } } }))).toBe(false);
  expect(isModelConfigValid(config({ chat: { reasoning: { budget_tokens: { min: 100, max: 99 } } } }))).toBe(false);
  expect(isModelConfigValid(config({ chat: { reasoning: { effort: { supported: ['high'], default: 'high' } } } }))).toBe(true);
});
