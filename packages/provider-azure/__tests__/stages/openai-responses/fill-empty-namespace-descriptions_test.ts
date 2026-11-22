import { test } from 'vitest';

import { fillEmptyNamespaceDescriptionsPayload } from '../../../src/stages/openai-responses/fill-empty-namespace-descriptions.ts';
import type { CanonicalOpenAIResponsesPayload } from '@floway-dev/protocols/openai-responses';
import { assertEquals } from '@floway-dev/test-utils';

type Payload = Omit<CanonicalOpenAIResponsesPayload, 'model'>;

test('fills empty namespace descriptions without mutating the caller payload', () => {
  const payload = {
    input: [{
      type: 'additional_tools',
      role: 'developer',
      tools: [
        { type: 'namespace', name: 'functions', description: '', tools: [] },
        { type: 'namespace', name: 'billing', description: 'Already documented.', tools: [] },
      ],
    }],
  } as unknown as Payload;

  const result = fillEmptyNamespaceDescriptionsPayload(payload) as typeof payload;
  assertEquals(
    ((result.input[0] as Extract<Payload['input'][number], { type: 'additional_tools' }>).tools[0] as { description: string }).description,
    'Tools in the functions namespace.',
  );
  assertEquals(
    ((result.input[0] as Extract<Payload['input'][number], { type: 'additional_tools' }>).tools[1] as { description: string }).description,
    'Already documented.',
  );
  assertEquals(payload.input[0] === result.input[0], false);
});
