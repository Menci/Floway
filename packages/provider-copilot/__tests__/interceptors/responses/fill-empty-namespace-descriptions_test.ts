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

test('fills Codex Responses Lite namespace descriptions before Copilot dispatch', async () => {
  const ctx = invocation({
    model: 'gpt-5.6-sol',
    input: [{
      type: 'additional_tools',
      role: 'developer',
      tools: [{
        type: 'namespace',
        name: 'functions',
        description: '',
        tools: [{ type: 'custom', name: 'exec', description: 'Execute code.' }],
      }],
    }],
  });

  await withEmptyNamespaceDescriptionsFilled(ctx, {}, async () => {});

  const [item] = ctx.payload.input;
  if (item?.type !== 'additional_tools') throw new Error('expected additional_tools input');
  assertEquals(item.tools[0], {
    type: 'namespace',
    name: 'functions',
    description: 'Tools in the functions namespace.',
    tools: [{ type: 'custom', name: 'exec', description: 'Execute code.' }],
  });
});
