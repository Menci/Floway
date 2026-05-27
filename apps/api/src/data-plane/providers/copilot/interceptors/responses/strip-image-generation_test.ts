import { test } from 'vitest';

import { stripImageGenerationFromPayload } from './strip-image-generation.ts';
import { assertEquals, assertFalse } from '../../../../../test-assert.ts';
import type { ResponsesPayload } from '@floway-dev/protocols/responses';

test('stripImageGenerationFromPayload removes image_generation tools', () => {
  const payload = {
    model: 'gpt-test',
    input: 'draw this',
    tools: [
      { type: 'image_generation' },
      {
        type: 'function',
        name: 'lookup',
        parameters: { type: 'object' },
        strict: false,
      },
    ],
    tool_choice: 'auto',
  } as ResponsesPayload;

  stripImageGenerationFromPayload(payload);

  assertEquals(payload.tools?.length, 1);
  assertEquals(payload.tools?.[0].type, 'function');
  assertEquals(payload.tool_choice, 'auto');
});

test('stripImageGenerationFromPayload removes forced image_generation tool_choice', () => {
  const payload = {
    model: 'gpt-test',
    input: 'draw this',
    tools: [{ type: 'image_generation' }],
    tool_choice: { type: 'image_generation' },
  } as ResponsesPayload;

  stripImageGenerationFromPayload(payload);

  assertFalse('tools' in payload);
  assertFalse('tool_choice' in payload);
});

test('stripImageGenerationFromPayload removes required tool_choice when no tools remain', () => {
  const payload = {
    model: 'gpt-test',
    input: 'draw this',
    tools: [{ type: 'image_generation' }],
    tool_choice: 'required',
  } as ResponsesPayload;

  stripImageGenerationFromPayload(payload);

  assertFalse('tools' in payload);
  assertFalse('tool_choice' in payload);
});

test('stripImageGenerationFromPayload preserves Copilot-accepted hosted and deferred tools', () => {
  // Codex uses `tool_search` and `namespace` for client-executed deferred tool
  // discovery and Copilot accepts `web_search`; the Copilot Responses target
  // must still see those entries even after image_generation is dropped.
  const payload = {
    model: 'gpt-test',
    input: 'search the web',
    tools: [
      {
        type: 'function',
        name: 'lookup',
        parameters: { type: 'object' },
        strict: false,
      },
      { type: 'web_search' },
      { type: 'tool_search', execution: 'x', description: 'y', parameters: {} },
      { type: 'namespace', name: 'ns', tools: [] },
      { type: 'image_generation', output_format: 'png' },
    ],
    tool_choice: 'auto',
  } as ResponsesPayload;

  stripImageGenerationFromPayload(payload);

  assertEquals(payload.tools?.map(tool => tool.type), ['function', 'web_search', 'tool_search', 'namespace']);
  assertEquals(payload.tool_choice, 'auto');
});

test('stripImageGenerationFromPayload preserves forced non-image hosted and deferred tool_choices', () => {
  for (const type of ['web_search', 'tool_search', 'namespace'] as const) {
    const payload = {
      model: 'gpt-test',
      input: 'search',
      tools: [{ type }],
      tool_choice: { type },
    } as ResponsesPayload;

    stripImageGenerationFromPayload(payload);

    assertEquals(payload.tools, [{ type }]);
    assertEquals(payload.tool_choice, { type });
  }
});

test('stripImageGenerationFromPayload preserves custom Freeform tools for downstream wrapping', () => {
  const payload = {
    model: 'gpt-test',
    input: 'do x',
    tools: [
      {
        type: 'function',
        name: 'lookup',
        parameters: { type: 'object' },
        strict: false,
      },
      { type: 'custom', name: 'freeform_other', description: 'x' },
    ],
    tool_choice: { type: 'custom', name: 'freeform_other' },
  } as ResponsesPayload;

  stripImageGenerationFromPayload(payload);

  assertEquals(payload.tools?.length, 2);
  assertEquals(payload.tools?.[1].type, 'custom');
  assertEquals(payload.tool_choice, { type: 'custom', name: 'freeform_other' });
});
