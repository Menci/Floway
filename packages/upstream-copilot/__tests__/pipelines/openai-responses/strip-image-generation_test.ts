import { test } from 'vitest';

import { stripImageGenerationFromPayload } from '../../../src/pipelines/openai-responses/strip-image-generation/shape.ts';
import type { CanonicalOpenAIResponsesPayload } from '@floway-dev/protocols/openai-responses';
import { assert, assertEquals } from '@floway-dev/test-utils';

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

  const stripped = stripImageGenerationFromPayload(payload);

  assertEquals(stripped.tool_choice, 'none');
  const item = stripped.input[0];
  assert(item.type === 'additional_tools');
  assertEquals(item.tools, [{ type: 'function', name: 'lookup', parameters: {} }]);
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

  const stripped = stripImageGenerationFromPayload(payload);

  assertEquals(stripped.tools?.map(tool => tool.type), ['function', 'web_search', 'tool_search', 'namespace']);
  assertEquals(stripped.tool_choice, 'auto');
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

  const stripped = stripImageGenerationFromPayload(payload);

  assertEquals(stripped.tool_choice, { type: 'allowed_tools', mode: 'required', tools: [{ type: 'function', name: 'lookup' }] });
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

  const stripped = stripImageGenerationFromPayload(payload);

  assertEquals(stripped.tool_choice, 'none');
  const item = stripped.input[0];
  assert(item.type === 'additional_tools');
  assertEquals(item.tools, [{ type: 'function', name: 'lookup', parameters: {} }]);
});
