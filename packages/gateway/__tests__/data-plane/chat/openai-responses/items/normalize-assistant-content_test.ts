import { test } from 'vitest';

import { normalizeAssistantInputText } from '../../../../../src/data-plane/chat/openai-responses/items/normalize-assistant-content.ts';
import type { CanonicalOpenAIResponsesInputItem } from '@floway-dev/protocols/openai-responses';
import { assertEquals } from '@floway-dev/test-utils';

test('rewrites assistant-role input_text content blocks to output_text', () => {
  const input: CanonicalOpenAIResponsesInputItem[] = [
    { type: 'message', role: 'user', content: [{ type: 'input_text', text: 'hi' }] },
    { type: 'message', role: 'assistant', content: [{ type: 'input_text', text: 'prior reply' }] },
  ];
  const out = normalizeAssistantInputText(input);
  assertEquals((out as CanonicalOpenAIResponsesInputItem[])[0], { type: 'message', role: 'user', content: [{ type: 'input_text', text: 'hi' }] });
  assertEquals((out as CanonicalOpenAIResponsesInputItem[])[1], { type: 'message', role: 'assistant', content: [{ type: 'output_text', text: 'prior reply' }] });
});
