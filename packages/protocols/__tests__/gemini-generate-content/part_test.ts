import { expect, test } from 'vitest';

import { geminiGenerateContentPartKind, type GeminiGenerateContentPart } from '../../src/gemini-generate-content/index.ts';

test('conflicting or missing data fields expose the invalid Part', () => {
  expect(() => geminiGenerateContentPartKind({ text: 'text', functionCall: { name: 'lookup' } } as unknown as GeminiGenerateContentPart)).toThrow();
  expect(() => geminiGenerateContentPartKind({})).toThrow();
});
