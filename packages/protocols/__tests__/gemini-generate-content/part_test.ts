import { expect, test } from 'vitest';

import { geminiGenerateContentPartKind, type GeminiGenerateContentPart } from '../../src/gemini-generate-content/index.ts';

test('data classification ignores metadata and preserves a standalone signature', () => {
  expect(geminiGenerateContentPartKind({ text: 'thought', thought: true, thoughtSignature: 'signed' })).toBe('text');
  expect(geminiGenerateContentPartKind({ functionCall: { name: 'lookup', args: {} } })).toBe('function_call');
  expect(geminiGenerateContentPartKind({ thoughtSignature: 'signed' })).toBeNull();
});

test('conflicting or missing data fields expose the invalid Part', () => {
  expect(() => geminiGenerateContentPartKind({ text: 'text', functionCall: { name: 'lookup' } } as unknown as GeminiGenerateContentPart)).toThrow('conflicting content fields: text, functionCall');
  expect(() => geminiGenerateContentPartKind({})).toThrow('no recognized content');
});
