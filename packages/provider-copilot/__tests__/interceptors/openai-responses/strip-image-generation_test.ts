import { test } from 'vitest';

import { stripImageGenerationFromPayload } from '../../../src/interceptors/openai-responses/strip-image-generation.ts';
import type { CanonicalOpenAIResponsesPayload } from '@floway-dev/protocols/openai-responses';
import { assert, assertEquals, assertFalse } from '@floway-dev/test-utils';

test('stripImageGenerationFromPayload removes image_generation tools', () => {
  const payload = {
    model: 'gpt-test',
    input: [{ type: 'message', role: 'user', content: 'draw this' }],
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
  } as CanonicalOpenAIResponsesPayload;

  stripImageGenerationFromPayload(payload);

  assertEquals(payload.tools?.length, 1);
  assertEquals(payload.tools?.[0].type, 'function');
  assertEquals(payload.tool_choice, 'auto');
});

test('stripImageGenerationFromPayload removes forced image_generation tool_choice', () => {
  const payload = {
    model: 'gpt-test',
    input: [{ type: 'message', role: 'user', content: 'draw this' }],
    tools: [{ type: 'image_generation' }],
    tool_choice: { type: 'image_generation' },
  } as CanonicalOpenAIResponsesPayload;

  stripImageGenerationFromPayload(payload);

  assertFalse('tools' in payload);
  assertFalse('tool_choice' in payload);
});

test('forced image generation cannot expose a surviving input-carried client tool', () => {
  const payload: CanonicalOpenAIResponsesPayload = {
    model: 'gpt-test',
    input: [{
      type: 'additional_tools', role: 'developer',
      tools: [
        { type: 'image_generation' },
        { type: 'function', name: 'lookup', parameters: {} },
      ],
    }],
    tool_choice: { type: 'image_generation' },
  };

  stripImageGenerationFromPayload(payload);

  assertEquals(payload.tool_choice, 'none');
  const item = payload.input[0];
  assert(item.type === 'additional_tools');
  assertEquals(item.tools, [{ type: 'function', name: 'lookup', parameters: {} }]);
});

test('stripImageGenerationFromPayload removes required tool_choice when no tools remain', () => {
  const payload = {
    model: 'gpt-test',
    input: [{ type: 'message', role: 'user', content: 'draw this' }],
    tools: [{ type: 'image_generation' }],
    tool_choice: 'required',
  } as CanonicalOpenAIResponsesPayload;

  stripImageGenerationFromPayload(payload);

  assertFalse('tools' in payload);
  assertFalse('tool_choice' in payload);
});

test('stripImageGenerationFromPayload preserves Copilot-accepted hosted and deferred tools', () => {
  // Codex uses `tool_search` and `namespace` for client-executed deferred tool
  // discovery and Copilot accepts `web_search`; the Copilot OpenAI Responses target
  // must still see those entries even after image_generation is dropped.
  const payload = {
    model: 'gpt-test',
    input: [{ type: 'message', role: 'user', content: 'search the web' }],
    tools: [
      {
        type: 'function',
        name: 'lookup',
        parameters: { type: 'object' },
        strict: false,
      },
      { type: 'web_search' },
      { type: 'tool_search', execution: 'x', description: 'y', parameters: {} },
      { type: 'namespace', name: 'ns', description: '', tools: [] },
      { type: 'image_generation', output_format: 'png' },
    ],
    tool_choice: 'auto',
  } as CanonicalOpenAIResponsesPayload;

  stripImageGenerationFromPayload(payload);

  assertEquals(payload.tools?.map(tool => tool.type), ['function', 'web_search', 'tool_search', 'namespace']);
  assertEquals(payload.tool_choice, 'auto');
});

test('stripImageGenerationFromPayload preserves forced non-image hosted and deferred tool_choices', () => {
  for (const type of ['web_search', 'tool_search', 'namespace'] as const) {
    const payload = {
      model: 'gpt-test',
      input: [{ type: 'message', role: 'user', content: 'search' }],
      tools: [{ type }],
      tool_choice: { type },
    } as CanonicalOpenAIResponsesPayload;

    stripImageGenerationFromPayload(payload);

    assertEquals(payload.tools, [{ type }]);
    assertEquals(payload.tool_choice, { type });
  }
});

test('stripImageGenerationFromPayload preserves custom Freeform tools for downstream wrapping', () => {
  const payload = {
    model: 'gpt-test',
    input: [{ type: 'message', role: 'user', content: 'do x' }],
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
  } as CanonicalOpenAIResponsesPayload;

  stripImageGenerationFromPayload(payload);

  assertEquals(payload.tools?.length, 2);
  assertEquals(payload.tools?.[1].type, 'custom');
  assertEquals(payload.tool_choice, { type: 'custom', name: 'freeform_other' });
});

test('strips image generation from input tool carriers in place', () => {
  const payload: CanonicalOpenAIResponsesPayload = {
    model: 'gpt-test',
    tools: [],
    tool_choice: 'required',
    input: [
      { type: 'additional_tools', role: 'developer', id: 'at_1', tools: [{ type: 'image_generation' }] },
      { type: 'message', role: 'user', content: 'hi' },
      { type: 'tool_search_output', call_id: 'search_1', tools: [{ type: 'image_generation' }, { type: 'web_search' }] },
    ],
  };

  stripImageGenerationFromPayload(payload);

  assertEquals(payload.input, [
    { type: 'additional_tools', role: 'developer', id: 'at_1', tools: [] },
    { type: 'message', role: 'user', content: 'hi' },
    { type: 'tool_search_output', call_id: 'search_1', tools: [{ type: 'web_search' }] },
  ]);
  assertEquals(payload.tool_choice, 'required');
});

test('drops required tool choice when input only supplied removed image generation', () => {
  const payload: CanonicalOpenAIResponsesPayload = {
    model: 'gpt-test',
    input: [{ type: 'additional_tools', role: 'developer', tools: [{ type: 'image_generation' }] }],
    tool_choice: 'required',
  };

  stripImageGenerationFromPayload(payload);

  assertEquals(payload.input, [{ type: 'additional_tools', role: 'developer', tools: [] }]);
  assertFalse('tool_choice' in payload);
});

test('removes filtered hosted selectors from allowed_tools without dropping client tools', () => {
  const payload: CanonicalOpenAIResponsesPayload = {
    model: 'gpt-test',
    input: [{
      type: 'additional_tools', role: 'developer',
      tools: [
        { type: 'image_generation' },
        { type: 'function', name: 'lookup', parameters: {} },
      ],
    }],
    tool_choice: {
      type: 'allowed_tools', mode: 'required',
      tools: [{ type: 'image_generation' }, { type: 'function', name: 'lookup' }],
    },
  };

  stripImageGenerationFromPayload(payload);

  assertEquals(payload.tool_choice, { type: 'allowed_tools', mode: 'required', tools: [{ type: 'function', name: 'lookup' }] });
});

test('keeps an unsatisfiable required allowed_tools choice explicit', () => {
  const payload: CanonicalOpenAIResponsesPayload = {
    model: 'gpt-test',
    input: [{ type: 'tool_search_output', tools: [{ type: 'image_generation' }] }],
    tool_choice: { type: 'allowed_tools', mode: 'required', tools: [{ type: 'image_generation' }] },
  };

  stripImageGenerationFromPayload(payload);

  assertEquals(payload.tool_choice, { type: 'allowed_tools', mode: 'required', tools: [] });
});

test('auto allowed_tools cannot expose tools excluded by the original selector', () => {
  const payload: CanonicalOpenAIResponsesPayload = {
    model: 'gpt-test',
    input: [{
      type: 'additional_tools', role: 'developer',
      tools: [
        { type: 'image_generation' },
        { type: 'function', name: 'lookup', parameters: {} },
      ],
    }],
    tool_choice: { type: 'allowed_tools', mode: 'auto', tools: [{ type: 'image_generation' }] },
  };

  stripImageGenerationFromPayload(payload);

  assertEquals(payload.tool_choice, 'none');
  const item = payload.input[0];
  assert(item.type === 'additional_tools');
  assertEquals(item.tools, [{ type: 'function', name: 'lookup', parameters: {} }]);
});

test('leaves unrelated allowed_tools choices unchanged', () => {
  const payload: CanonicalOpenAIResponsesPayload = {
    model: 'gpt-test', input: [],
    tool_choice: { type: 'allowed_tools', mode: 'auto', tools: [] },
  };

  stripImageGenerationFromPayload(payload);

  assertEquals(payload.tool_choice, { type: 'allowed_tools', mode: 'auto', tools: [] });
});
