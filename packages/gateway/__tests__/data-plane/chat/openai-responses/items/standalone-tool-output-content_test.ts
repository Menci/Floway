import { test } from 'vitest';

import { standaloneToolOutputContent } from '../../../../../src/data-plane/chat/openai-responses/items/standalone-tool-output-content.ts';
import { tryCatchChatServeFailure, type InputErrorDetails } from '../../../../../src/data-plane/chat/shared/errors.ts';
import type { OpenAIResponsesFunctionCallOutputItem } from '@floway-dev/protocols/openai-responses';
import { assertEquals, assertThrows } from '@floway-dev/test-utils';

const standalone = (output: OpenAIResponsesFunctionCallOutputItem['output'], name: string | null = 'goal_objective'): OpenAIResponsesFunctionCallOutputItem => ({
  type: 'function_call_output',
  id: 'fco_1',
  name,
  namespace: 'agent',
  output,
});

test('standaloneToolOutputContent wraps string output in external markers named after the tool', () => {
  assertEquals(standaloneToolOutputContent(standalone('Write <tests> & docs'), 0), [
    { type: 'input_text', text: '<external_goal_objective>Write <tests> & docs</external_goal_objective>' },
  ]);
});

test('standaloneToolOutputContent merges text parts into the markers and keeps media parts in place', () => {
  assertEquals(standaloneToolOutputContent(standalone([
    { type: 'input_text', text: 'Companion Page snapshot part 1 of 1:\n' },
    { type: 'input_text', text: '{"page_id":null}' },
    { type: 'input_image', image_url: 'https://example.com/page.png', detail: 'auto' },
  ], 'codex_apps_selected_page_part_1_of_1'), 0), [
    { type: 'input_text', text: '<external_codex_apps_selected_page_part_1_of_1>Companion Page snapshot part 1 of 1:\n{"page_id":null}' },
    { type: 'input_image', image_url: 'https://example.com/page.png', detail: 'auto' },
    { type: 'input_text', text: '</external_codex_apps_selected_page_part_1_of_1>' },
  ]);
});

test('standaloneToolOutputContent wraps an empty output', () => {
  assertEquals(standaloneToolOutputContent(standalone([]), 0), [
    { type: 'input_text', text: '<external_goal_objective></external_goal_objective>' },
  ]);
});

test.each([null, ''])('standaloneToolOutputContent rejects a standalone output whose name is %j', name => {
  const error = assertThrows(() => standaloneToolOutputContent(standalone('x', name), 3));
  assertEquals(tryCatchChatServeFailure<InputErrorDetails & { kind: 'invalid-input' }>(error), {
    kind: 'invalid-input',
    message: 'A function call output without a call_id requires a name.',
    param: 'input[3].name',
  });
});
