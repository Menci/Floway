import { test } from 'vitest';

import { agentMessageShim } from '../../../../../src/data-plane/chat/openai-responses/stages/agent-message-shim.ts';
import { createManagedProtocolFrames, runChatStage, stubRouteCandidate } from '../../../../test-utils/chat-pipeline.ts';
import type { CanonicalOpenAIResponsesInputItem, OpenAIResponsesInputAgentMessageItem } from '@floway-dev/protocols/openai-responses';
import { decodeResponseBody, type FlagId } from '@floway-dev/provider';
import { assert, assertEquals, testTelemetryModelIdentity } from '@floway-dev/test-utils';

const okEvents = (env: Parameters<Parameters<typeof runChatStage>[0]['next']>[1]) => ({
  type: 'events' as const,
  events: createManagedProtocolFrames(env, []),
  modelIdentity: testTelemetryModelIdentity,
});
const flag = new Set<FlagId>(['openai-responses-agent-message-shim']);

const lower = async (
  input: CanonicalOpenAIResponsesInputItem[],
  options: { enabledFlags?: ReadonlySet<FlagId>; targetApi?: 'openaiResponses' | 'anthropicMessages' | 'openaiChatCompletions' } = {},
) => {
  const candidate = stubRouteCandidate({ enabledFlags: options.enabledFlags, endpoints: { openaiResponses: {} } });
  let seen: CanonicalOpenAIResponsesInputItem[] | undefined;
  const { outcome } = await runChatStage({
    stage: agentMessageShim,
    facts: {
      'route.candidate': candidate,
      'request.payload': { model: 'test-model', input },
      'request.action': 'generate',
      'route.targetApi': options.targetApi ?? 'openaiResponses',
    },
    next: async (facts, env) => {
      seen = facts['request.payload'].input;
      return okEvents(env);
    },
  });
  return { outcome, seen };
};

const newTask: OpenAIResponsesInputAgentMessageItem = {
  type: 'agent_message', author: '/root', recipient: '/root/route_audit',
  content: [{ type: 'input_text', text: 'Message Type: NEW_TASK\nPayload:\nAudit the route <a> & <b>.' }],
};

test('lowers agent_message items when enabled', async () => {
  const { seen } = await lower([newTask], { enabledFlags: flag });
  assert(seen !== undefined);
  assertEquals(seen[0]?.type, 'message');
  assertEquals(seen[0]?.type === 'message' ? seen[0].role : undefined, 'user');
});

test('forwards native agent_message items when the flag is off', async () => {
  const { seen } = await lower([newTask]);
  assert(seen !== undefined);
  assertEquals(seen, [newTask]);
});

test('returns an OpenAI 400 envelope when lowering fails', async () => {
  const { outcome, seen } = await lower([{ type: 'agent_message', author: '/root', recipient: '/root/worker', content: [{ type: 'encrypted_content', encrypted_content: 'opaque' }] }], { enabledFlags: flag });
  assertEquals(seen, undefined);
  assert(outcome.type === 'api-error');
  assertEquals(outcome.http.status, 400);
  assertEquals((JSON.parse(decodeResponseBody(outcome.body)) as { error: { param: string } }).error.param, 'agent_message.content[0].type');
});
