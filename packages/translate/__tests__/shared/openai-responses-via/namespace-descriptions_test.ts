import { test } from 'vitest';

import { flattenNamespaceTools } from '../../../src/shared/openai-responses-via/namespace-tools.ts';
import type { CanonicalOpenAIResponsesPayload, OpenAIResponsesTool } from '@floway-dev/protocols/openai-responses';
import { assertEquals } from '@floway-dev/test-utils';

const functionTool = (name: string): Extract<OpenAIResponsesTool, { type: 'function' }> => ({ type: 'function', name, parameters: { type: 'object' } });

test('callable projection retains parent and child descriptions for translated targets', () => {
  const request: CanonicalOpenAIResponsesPayload = {
    model: 'm', input: [], tools: [
      { type: 'namespace', name: 'files', description: 'Read-only access. Never modify files.', tools: [{ ...functionTool('read'), description: 'Read a file.' }, { type: 'custom', name: 'inspect' }] },
      { type: 'namespace', name: 'empty', description: '', tools: [{ ...functionTool('read'), description: 'Child-only description.' }] },
    ],
  };
  const original = structuredClone(request);
  const call = flattenNamespaceTools(request);
  assertEquals(call.payload.tools?.map(tool => 'description' in tool ? tool.description : undefined), ['Read-only access. Never modify files.\n\nRead a file.', 'Read-only access. Never modify files.', 'Child-only description.']);
  assertEquals(request, original);
});
