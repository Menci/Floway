import { test } from 'vitest';

import { normalizeAssistantInputText } from './normalize-assistant-content.ts';
import type { ResponsesInputItem } from '@floway-dev/protocols/responses';
import { assert, assertEquals } from '@floway-dev/test-utils';

test('rewrites assistant-role input_text content blocks to output_text', () => {
  const input: ResponsesInputItem[] = [
    { type: 'message', role: 'user', content: [{ type: 'input_text', text: 'hi' }] },
    { type: 'message', role: 'assistant', content: [{ type: 'input_text', text: 'prior reply' }] },
  ];
  const out = normalizeAssistantInputText(input);
  assertEquals((out as ResponsesInputItem[])[0], { type: 'message', role: 'user', content: [{ type: 'input_text', text: 'hi' }] });
  assertEquals((out as ResponsesInputItem[])[1], { type: 'message', role: 'assistant', content: [{ type: 'output_text', text: 'prior reply' }] });
});

test('returns the input array reference unchanged when nothing needs rewriting', () => {
  const input: ResponsesInputItem[] = [
    { type: 'message', role: 'assistant', content: [{ type: 'output_text', text: 'already correct' }] },
  ];
  const out = normalizeAssistantInputText(input);
  assert(out === input);
});

test('preserves user-role input_text content (input_text is correct on user)', () => {
  const input: ResponsesInputItem[] = [
    { type: 'message', role: 'user', content: [{ type: 'input_text', text: 'hello' }] },
  ];
  const out = normalizeAssistantInputText(input);
  assert(out === input);
});

test('handles assistant message with string content (no rewrite needed)', () => {
  const input: ResponsesInputItem[] = [
    { type: 'message', role: 'assistant', content: 'plain string' },
  ];
  const out = normalizeAssistantInputText(input);
  assert(out === input);
});

test('rewrites every input_text block in a multi-block assistant message', () => {
  const input: ResponsesInputItem[] = [
    {
      type: 'message',
      role: 'assistant',
      content: [
        { type: 'input_text', text: 'first chunk' },
        { type: 'input_text', text: 'second chunk' },
      ],
    },
  ];
  const out = normalizeAssistantInputText(input);
  assertEquals((out as ResponsesInputItem[])[0], {
    type: 'message',
    role: 'assistant',
    content: [
      { type: 'output_text', text: 'first chunk' },
      { type: 'output_text', text: 'second chunk' },
    ],
  });
});
