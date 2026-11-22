import { test } from 'vitest';

import { fillCopilotEmptyNamespaceDescriptions } from '../../../src/stages/openai-responses/fill-empty-namespace-descriptions.ts';
import type { CanonicalOpenAIResponsesPayload } from '@floway-dev/protocols/openai-responses';
import { assertEquals } from '@floway-dev/test-utils';

test('fills Codex OpenAI Responses Lite namespace descriptions before Copilot dispatch', async () => {
  const describedNamespace = {
    type: 'namespace' as const,
    name: 'collaboration',
    description: 'Tools for spawning and managing sub-agents.',
    tools: [{ type: 'function' as const, name: 'spawn_agent', description: 'Spawn an agent.' }],
  };
  const payload: CanonicalOpenAIResponsesPayload = {
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
  };
  const rewritten = fillCopilotEmptyNamespaceDescriptions(payload);

  const [item] = rewritten.input;
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
