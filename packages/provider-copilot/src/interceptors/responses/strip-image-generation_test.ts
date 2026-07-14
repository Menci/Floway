import { test } from 'vitest';

import type { ResponsesBoundaryCtx } from './types.ts';
import { withImageGenerationStripped } from './strip-image-generation.ts';
import type { CanonicalResponsesPayload } from '@floway-dev/protocols/responses';
import { assertEquals, assertFalse } from '@floway-dev/test-utils';

const applyInterceptor = async (payload: CanonicalResponsesPayload): Promise<void> => {
  await withImageGenerationStripped(
    { payload } as ResponsesBoundaryCtx,
    {},
    async () => undefined,
  );
};

test('withImageGenerationStripped removes image_generation tools', async () => {
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
  } as CanonicalResponsesPayload;

  await applyInterceptor(payload);

  assertEquals(payload.tools?.length, 1);
  assertEquals(payload.tools?.[0].type, 'function');
  assertEquals(payload.tool_choice, 'auto');
});

test('withImageGenerationStripped removes forced image_generation tool_choice', async () => {
  const payload = {
    model: 'gpt-test',
    input: [{ type: 'message', role: 'user', content: 'draw this' }],
    tools: [{ type: 'image_generation' }],
    tool_choice: { type: 'image_generation' },
  } as CanonicalResponsesPayload;

  await applyInterceptor(payload);

  assertFalse('tools' in payload);
  assertFalse('tool_choice' in payload);
});

test('withImageGenerationStripped removes required tool_choice when no tools remain', async () => {
  const payload = {
    model: 'gpt-test',
    input: [{ type: 'message', role: 'user', content: 'draw this' }],
    tools: [{ type: 'image_generation' }],
    tool_choice: 'required',
  } as CanonicalResponsesPayload;

  await applyInterceptor(payload);

  assertFalse('tools' in payload);
  assertFalse('tool_choice' in payload);
});

test('withImageGenerationStripped removes the image_gen namespace tool but keeps other namespaces', async () => {
  // Recent Codex clients ship image generation as a deferred-tool namespace
  // named `image_gen`; Copilot rejects it as a namespace collision. Unrelated
  // namespaces must survive.
  const payload = {
    model: 'gpt-test',
    input: [{ type: 'message', role: 'user', content: 'draw this' }],
    tools: [
      { type: 'namespace', name: 'image_gen', description: 'Generate an image.', tools: [{ type: 'function', name: 'imagegen' }] },
      { type: 'namespace', name: 'browser', description: 'Browse.', tools: [] },
    ],
    tool_choice: 'auto',
  } as CanonicalResponsesPayload;

  await applyInterceptor(payload);

  assertEquals(payload.tools?.length, 1);
  assertEquals((payload.tools?.[0] as { name?: string }).name, 'browser');
  assertEquals(payload.tool_choice, 'auto');
});

test('withImageGenerationStripped removes a forced image_gen namespace tool_choice', async () => {
  const payload = {
    model: 'gpt-test',
    input: [{ type: 'message', role: 'user', content: 'draw this' }],
    tools: [{ type: 'namespace', name: 'image_gen', description: 'Generate an image.', tools: [] }],
    tool_choice: { type: 'namespace', name: 'image_gen' },
  } as CanonicalResponsesPayload;

  await applyInterceptor(payload);

  assertFalse('tools' in payload);
  assertFalse('tool_choice' in payload);
});

test('withImageGenerationStripped preserves a tool_choice naming a surviving namespace', async () => {
  const payload = {
    model: 'gpt-test',
    input: [{ type: 'message', role: 'user', content: 'browse' }],
    tools: [
      { type: 'namespace', name: 'image_gen', description: 'Generate an image.', tools: [] },
      { type: 'namespace', name: 'browser', description: 'Browse.', tools: [] },
    ],
    tool_choice: { type: 'namespace', name: 'browser' },
  } as CanonicalResponsesPayload;

  await applyInterceptor(payload);

  assertEquals(payload.tools?.length, 1);
  assertEquals((payload.tools?.[0] as { name?: string }).name, 'browser');
  assertEquals(payload.tool_choice, { type: 'namespace', name: 'browser' });
});

test('withImageGenerationStripped preserves Copilot-accepted hosted and deferred tools', async () => {
  // Codex uses `tool_search` and `namespace` for client-executed deferred tool
  // discovery and Copilot accepts `web_search`; the Copilot Responses target
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
      { type: 'namespace', name: 'ns', description: 'Namespace.', tools: [] },
      { type: 'image_generation', output_format: 'png' },
      { type: 'namespace', name: 'image_gen', description: 'Generate an image.', tools: [] },
    ],
    tool_choice: 'auto',
  } as CanonicalResponsesPayload;

  await applyInterceptor(payload);

  assertEquals(payload.tools?.map(tool => tool.type), ['function', 'web_search', 'tool_search', 'namespace']);
  assertEquals((payload.tools?.[3] as { name?: string }).name, 'ns');
  assertEquals(payload.tool_choice, 'auto');
});

test('withImageGenerationStripped preserves forced non-image hosted tool_choices', async () => {
  for (const type of ['web_search', 'tool_search'] as const) {
    const payload = {
      model: 'gpt-test',
      input: [{ type: 'message', role: 'user', content: 'search' }],
      tools: [{ type }],
      tool_choice: { type },
    } as CanonicalResponsesPayload;

    await applyInterceptor(payload);

    assertEquals(payload.tools, [{ type }]);
    assertEquals(payload.tool_choice, { type });
  }
});

test('withImageGenerationStripped preserves custom Freeform tools for downstream wrapping', async () => {
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
  } as CanonicalResponsesPayload;

  await applyInterceptor(payload);

  assertEquals(payload.tools?.length, 2);
  assertEquals(payload.tools?.[1].type, 'custom');
  assertEquals(payload.tool_choice, { type: 'custom', name: 'freeform_other' });
});
