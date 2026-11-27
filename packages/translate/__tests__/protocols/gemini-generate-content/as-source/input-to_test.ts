import { test } from 'vitest';

import { readGeminiGenerateContentRequest } from '../../../../src/protocols/gemini-generate-content/as-source/input-to.ts';
import { FAST_SERVICE_TIER } from '@floway-dev/protocols/common';
import { assertEquals } from '@floway-dev/test-utils';

test.each([
  ['LOW', 'low'],
  ['MEDIUM', 'medium'],
  ['HIGH', 'high'],
  ['XHIGH', 'xhigh'],
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

test.each([
  [FAST_SERVICE_TIER, FAST_SERVICE_TIER],
  ['standard', 'default'],
  ['flex', 'flex'],
  ['', undefined],
  [undefined, undefined],
] as const)('serviceTier %s maps to IR service_tier %s', (serviceTier, expected) => {
  const reading = readGeminiGenerateContentRequest({
    model: 'm',
    contents: [],
    ...(serviceTier === undefined ? {} : { serviceTier }),
  });
  assertEquals(reading.request.settings.service_tier, expected);
});
