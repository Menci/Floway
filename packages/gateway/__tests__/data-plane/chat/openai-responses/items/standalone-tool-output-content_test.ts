import { test } from 'vitest';

import { standaloneToolOutputContent } from '../../../../../src/data-plane/chat/openai-responses/items/standalone-tool-output-content.ts';
import { move } from '@floway-dev/pipeline';
import type { OpenAIResponsesFunctionCallOutputItem } from '@floway-dev/protocols/openai-responses';
import { assertEquals } from '@floway-dev/test-utils';

const standalone = (output: OpenAIResponsesFunctionCallOutputItem['output'], name: string | null = 'goal_objective'): OpenAIResponsesFunctionCallOutputItem => ({
  type: 'function_call_output',
  id: 'fco_1',
  name,
  namespace: 'agent',
  output,
});

test('standaloneToolOutputContent merges text parts into the markers and keeps media parts in place', () => {
  assertEquals(standaloneToolOutputContent(move(standalone([
    { type: 'input_text', text: 'Companion Page snapshot part 1 of 1:\n' },
    { type: 'input_text', text: '{"page_id":null}' },
    { type: 'input_image', image_url: 'https://example.com/page.png', detail: 'auto' },
    { type: 'input_text', text: 'page footer' },
  ], 'codex_apps_selected_page_part_1_of_1')), 0), [
    { type: 'input_text', text: '<external_codex_apps_selected_page_part_1_of_1>Companion Page snapshot part 1 of 1:\n{"page_id":null}' },
    { type: 'input_image', image_url: 'https://example.com/page.png', detail: 'auto' },
    { type: 'input_text', text: 'page footer</external_codex_apps_selected_page_part_1_of_1>' },
  ]);
});
