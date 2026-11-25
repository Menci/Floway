import { test } from 'vitest';

import { fillEmptyNamespaceDescriptions } from '../../../src/pipelines/openai-responses/fill-empty-namespace-descriptions.ts';
import { inspectStages, type StageFixture } from '../inspect.ts';
import type { CanonicalOpenAIResponsesPayload } from '@floway-dev/protocols/openai-responses';
import { assertEquals, stubProviderModel } from '@floway-dev/test-utils';

const invocation = (payload: CanonicalOpenAIResponsesPayload): StageFixture<'openaiResponses'> => ({
  payload,
  headers: new Headers(),
  model: stubProviderModel({ endpoints: { openaiResponses: {} } }),
});

test('fills Codex OpenAI Responses Lite namespace descriptions before Copilot dispatch', async () => {
  const describedNamespace = {
    type: 'namespace' as const,
    name: 'collaboration',
    description: 'Tools for spawning and managing sub-agents.',
    tools: [{ type: 'function' as const, name: 'spawn_agent', description: 'Spawn an agent.' }],
  };
  const fixture = invocation({
    model: 'gpt-5.6-sol',
    input: [{
      type: 'additional_tools',
      role: 'developer',
      tools: [
        {
          type: 'namespace',
          name: 'functions',
          description: '',
          tools: [{ type: 'custom', name: 'exec', description: 'Execute code.' }],
        },
        describedNamespace,
      ],
    }],
  });

  const ctx = await inspectStages('openaiResponses', fillEmptyNamespaceDescriptions('openaiResponses'), fixture);

  const [item] = ctx.payload.input;
  if (item?.type !== 'additional_tools') throw new Error('expected additional_tools input');
  assertEquals(item.tools, [
    {
      type: 'namespace',
      name: 'functions',
      description: 'Tools in the functions namespace.',
      tools: [{ type: 'custom', name: 'exec', description: 'Execute code.' }],
    },
    describedNamespace,
  ]);
});
