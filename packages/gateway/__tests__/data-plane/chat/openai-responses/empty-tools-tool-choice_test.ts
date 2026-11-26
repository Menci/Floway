import { test } from 'vitest';

import { observeResponsesRequest } from './request-stage.ts';
import { normalizeOpenAIResponsesEmptyToolsToolChoice } from '../../../../src/data-plane/chat/openai-responses/empty-tools-tool-choice.ts';
import type { CanonicalOpenAIResponsesPayload } from '@floway-dev/protocols/openai-responses';
import { assertEquals } from '@floway-dev/test-utils';

const shape = async (payload: CanonicalOpenAIResponsesPayload) =>
  (await observeResponsesRequest(normalizeOpenAIResponsesEmptyToolsToolChoice, payload, new Set(['empty-tools-tool-choice-none']))).seen;

const base = { model: 'm', input: [{ type: 'message' as const, role: 'user' as const, content: 'hi' }] };

test('responses empty tools rewrites tool_choice to none', async () => {
  const payload = await shape({ ...base, tools: [], tool_choice: 'auto' });

  assertEquals(payload?.tools, []);
  assertEquals(payload?.tool_choice, 'none');
});

test('responses keeps tool choice when an input item supplies tools', async () => {
  for (const item of [
    { type: 'additional_tools' as const, role: 'developer' as const, tools: [{ type: 'web_search' as const }] },
    { type: 'tool_search_output' as const, tools: [{ type: 'web_search' as const }] },
  ]) {
    const payload = await shape({ ...base, tools: [], input: [item], tool_choice: 'required' });
    assertEquals(payload?.tool_choice, 'required');
  }
});
