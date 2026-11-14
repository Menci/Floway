import { test } from 'vitest';

import { readGeminiGenerateContentRequest } from '../../../../src/protocols/gemini-generate-content/as-source/input-to.ts';
import { assertEquals } from '@floway-dev/test-utils';

test.each([
  ['LOW', 'low'],
  ['MEDIUM', 'medium'],
  ['HIGH', 'high'],
  ['MINIMAL', 'minimal'],
  ['THINKING_LEVEL_UNSPECIFIED', undefined],
  ['', ''],
  ['VENDOR_Turbo', 'VENDOR_Turbo'],
  ['Low', 'Low'],
] as const)('thinkingLevel %s maps to effort %s', (thinkingLevel, effort) => {
  assertEquals(readGeminiGenerateContentRequest({ model: 'm', contents: [], generationConfig: { thinkingConfig: { thinkingLevel } } }).request.settings.reasoning_effort, effort);
});

test('empty thoughts do not enter IR or split visible text', () => {
  const reading = readGeminiGenerateContentRequest({
    model: 'm', contents: [{
      role: 'model', parts: [
        { text: 'before' },
        { thought: true, text: '', thoughtSignature: 'opaque' },
        { text: 'after' },
        { thought: true, text: 'reasoning' },
        { text: 'answer' },
      ],
    }],
  });
  assertEquals(reading.turns[0].toIRInputTurns(), [{
    kind: 'assistant', items: [
      { type: 'message', content: [{ type: 'text', text: 'before' }, { type: 'text', text: 'after' }] },
      { type: 'reasoning', id: 'gemini_reasoning_0_3', summary: ['reasoning'] },
      { type: 'message', content: [{ type: 'text', text: 'answer' }] },
    ],
  }]);
});

test('entirely empty thoughts leave no reasoning in input IR', () => {
  const reading = readGeminiGenerateContentRequest({
    model: 'm', contents: [{ role: 'model', parts: [{ thought: true, text: '' }] }],
  });
  assertEquals(reading.turns[0].toIRInputTurns(), [{ kind: 'assistant', items: [] }]);
});
