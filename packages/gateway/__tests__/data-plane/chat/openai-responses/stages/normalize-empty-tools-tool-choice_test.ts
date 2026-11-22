import { test } from 'vitest';

import { normalizeEmptyToolsToolChoice } from '../../../../../src/data-plane/chat/openai-responses/stages/normalize-empty-tools-tool-choice.ts';
import { createManagedProtocolFrames, runChatStage, stubRouteCandidate } from '../../../../test-utils/chat-pipeline.ts';
import { assertEquals, testTelemetryModelIdentity } from '@floway-dev/test-utils';

test('sets tool_choice to none only for an explicit empty tool list', async () => {
  let payload: { tool_choice?: unknown } | undefined;
  await runChatStage({
    stage: normalizeEmptyToolsToolChoice,
    facts: { 'route.candidate': stubRouteCandidate({ enabledFlags: ['empty-tools-tool-choice-none'] }), 'request.payload': { model: 'm', input: [], tools: [], tool_choice: 'required' }, 'request.action': 'generate', 'route.targetApi': 'openaiResponses' },
    next: (provided, env) => {
      payload = provided['request.payload'];
      return { type: 'events' as const, events: createManagedProtocolFrames(env, []), modelIdentity: testTelemetryModelIdentity };
    },
  });
  assertEquals(payload?.tool_choice, 'none');
});
