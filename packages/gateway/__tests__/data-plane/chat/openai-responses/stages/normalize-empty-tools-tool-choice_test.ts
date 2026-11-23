import { test } from 'vitest';

import { driveResponsesStage } from './drive.ts';
import { normalizeEmptyToolsToolChoice } from '../../../../../src/data-plane/chat/openai-responses/stages/normalize-empty-tools-tool-choice.ts';
import type { CanonicalOpenAIResponsesPayload } from '@floway-dev/protocols/openai-responses';
import { assert, assertEquals } from '@floway-dev/test-utils';

const rewrite = async (input: CanonicalOpenAIResponsesPayload) => {
  const { seen, done } = await driveResponsesStage(normalizeEmptyToolsToolChoice, input, { enabledFlags: new Set(['empty-tools-tool-choice-none']) });
  assert(seen !== undefined);
  assertEquals(await done, { ok: true });
  return { payload: seen };
};

const base = { model: 'm', input: [{ type: 'message' as const, role: 'user' as const, content: 'hi' }] };

test('responses empty tools rewrites tool_choice to none', async () => {
  const input = await rewrite({ ...base, tools: [], tool_choice: 'auto' });

  assertEquals(input.payload.tools, []);
  assertEquals(input.payload.tool_choice, 'none');
});

test('responses keeps tool choice when an input item supplies tools', async () => {
  for (const item of [
    { type: 'additional_tools' as const, role: 'developer' as const, tools: [{ type: 'web_search' as const }] },
    { type: 'tool_search_output' as const, tools: [{ type: 'web_search' as const }] },
  ]) {
    const input = await rewrite({ ...base, tools: [], input: [item], tool_choice: 'required' });
    assertEquals(input.payload.tool_choice, 'required');
  }
});
