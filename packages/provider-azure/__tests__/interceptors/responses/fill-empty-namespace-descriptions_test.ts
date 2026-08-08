import { test } from 'vitest';

import { withEmptyNamespaceDescriptionsFilled } from '../../../src/interceptors/responses/fill-empty-namespace-descriptions.ts';
import type { ResponsesBoundaryCtx } from '../../../src/interceptors/responses/types.ts';
import type { CanonicalResponsesPayload } from '@floway-dev/protocols/responses';
import { assertEquals, stubProviderModel } from '@floway-dev/test-utils';

const invocation = (payload: CanonicalResponsesPayload): ResponsesBoundaryCtx => ({
  payload,
  headers: new Headers(),
  model: stubProviderModel({ endpoints: { responses: {} } }),
  action: 'generate',
});

test('fills Codex Responses Lite namespace descriptions before Azure dispatch', async () => {
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
