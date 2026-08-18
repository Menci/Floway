import { test } from 'vitest';

import { withEmptyNamespaceDescriptionsFilled } from '../../../src/interceptors/openai-responses/fill-empty-namespace-descriptions.ts';
import type { OpenAIResponsesBoundaryCtx } from '../../../src/interceptors/openai-responses/types.ts';
import type { CanonicalOpenAIResponsesPayload } from '@floway-dev/protocols/openai-responses';
import { assertEquals, stubProviderModel } from '@floway-dev/test-utils';

const invocation = (payload: CanonicalOpenAIResponsesPayload): OpenAIResponsesBoundaryCtx => ({
  payload,
  headers: new Headers(),
  model: stubProviderModel({ endpoints: { openaiResponses: {} } }),
  action: 'generate',
});

test('fills Codex OpenAI Responses Lite namespace descriptions before Copilot dispatch', async () => {
  const describedNamespace = {
    type: 'namespace' as const,
    name: 'collaboration',
    description: 'Tools for spawning and managing sub-agents.',
    tools: [{ type: 'function' as const, name: 'spawn_agent', description: 'Spawn an agent.' }],
  };
  const ctx = invocation({
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

  await withEmptyNamespaceDescriptionsFilled(ctx, {}, async () => {});

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
