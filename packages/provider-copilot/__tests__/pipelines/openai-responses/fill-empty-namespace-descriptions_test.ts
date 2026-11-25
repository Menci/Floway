import { test } from 'vitest';

import { fillEmptyNamespaceDescriptions } from '../../../src/pipelines/openai-responses/fill-empty-namespace-descriptions.ts';
import { runStage, type StageRequest } from '../stage.ts';
import type { CanonicalOpenAIResponsesPayload } from '@floway-dev/protocols/openai-responses';
import { assertEquals } from '@floway-dev/test-utils';

const requestFor = (payload: CanonicalOpenAIResponsesPayload): StageRequest<'openaiResponses'> => ({
  payload,
  headers: new Headers(),
});

test('fills Codex OpenAI Responses Lite namespace descriptions before Copilot dispatch', async () => {
  const describedNamespace = {
    type: 'namespace' as const,
    name: 'collaboration',
    description: 'Tools for spawning and managing sub-agents.',
    tools: [{ type: 'function' as const, name: 'spawn_agent', description: 'Spawn an agent.' }],
  };
  const request = requestFor({
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

  const result = await runStage(fillEmptyNamespaceDescriptions, 'openaiResponses', request);

  const [item] = result.payload.input;
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
