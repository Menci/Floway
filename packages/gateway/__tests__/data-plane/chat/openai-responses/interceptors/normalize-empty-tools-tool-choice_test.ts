import { test } from 'vitest';

import { withEmptyToolsToolChoiceNormalized } from '../../../../../src/data-plane/chat/openai-responses/interceptors/normalize-empty-tools-tool-choice.ts';
import type { OpenAIResponsesInvocation } from '../../../../../src/data-plane/chat/openai-responses/interceptors/types.ts';
import { mockChatGatewayCtx } from '../../../../test-utils/gateway-ctx.ts';
import type { CanonicalOpenAIResponsesPayload } from '@floway-dev/protocols/openai-responses';
import { assertEquals, stubModelCandidate, testTelemetryModelIdentity } from '@floway-dev/test-utils';
import { eventResult, type FlagId } from '@floway-dev/upstream';

const stubCtx = mockChatGatewayCtx();
const okEvents = () => Promise.resolve(eventResult((async function* () {})(), testTelemetryModelIdentity));

const invocation = (
  payload: CanonicalOpenAIResponsesPayload,
  enabledFlags: ReadonlySet<FlagId> = new Set(['empty-tools-tool-choice-none']),
): OpenAIResponsesInvocation => ({
  payload,
  candidate: stubModelCandidate({ enabledFlags }),
  targetApi: 'openaiResponses',
  headers: new Headers(),
  action: 'generate',
});

const base = { model: 'm', input: [{ type: 'message' as const, role: 'user' as const, content: 'hi' }] };

test('responses empty tools rewrites tool_choice to none', async () => {
  const input = invocation({ ...base, tools: [], tool_choice: 'auto' });

  await withEmptyToolsToolChoiceNormalized(input, stubCtx, okEvents);

  assertEquals(input.payload.tools, []);
  assertEquals(input.payload.tool_choice, 'none');
});

test('responses keeps tool choice when an input item supplies tools', async () => {
  for (const item of [
    { type: 'additional_tools' as const, role: 'developer' as const, tools: [{ type: 'web_search' as const }] },
    { type: 'tool_search_output' as const, tools: [{ type: 'web_search' as const }] },
  ]) {
    const input = invocation({ ...base, tools: [], input: [item], tool_choice: 'required' });
    await withEmptyToolsToolChoiceNormalized(input, stubCtx, okEvents);
    assertEquals(input.payload.tool_choice, 'required');
  }
});
