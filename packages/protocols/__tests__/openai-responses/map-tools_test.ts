import { test } from 'vitest';

import { mapOpenAIResponsesTools, type CanonicalOpenAIResponsesPayload, type OpenAIResponsesTool } from '../../src/openai-responses/index.ts';
import { assertEquals } from '@floway-dev/test-utils';

const functionTool = {
  type: 'function' as const,
  name: 'lookup',
  description: 'Look up a record.',
  parameters: { type: 'object', properties: {} },
};

test('maps tools in every OpenAI Responses request container without mutating the source', () => {
  const payload: CanonicalOpenAIResponsesPayload = {
    model: 'gpt-test',
    tools: [{ type: 'namespace', name: 'top', description: '', tools: [functionTool] }],
    input: [
      {
        type: 'additional_tools',
        role: 'developer',
        tools: [{ type: 'namespace', name: 'functions', description: '', tools: [functionTool] }],
      },
      {
        type: 'tool_search_output',
        tools: [{ type: 'namespace', name: 'searched', description: '', tools: [functionTool] }],
      },
    ],
  };
  const fillDescription = (tool: OpenAIResponsesTool): OpenAIResponsesTool => tool.type === 'namespace'
    ? { ...tool, description: `Tools in the ${tool.name} namespace.` }
    : tool;

  assertEquals(mapOpenAIResponsesTools(payload, fillDescription), {
    model: 'gpt-test',
    tools: [{ type: 'namespace', name: 'top', description: 'Tools in the top namespace.', tools: [functionTool] }],
    input: [
      {
        type: 'additional_tools',
        role: 'developer',
        tools: [{ type: 'namespace', name: 'functions', description: 'Tools in the functions namespace.', tools: [functionTool] }],
      },
      {
        type: 'tool_search_output',
        tools: [{ type: 'namespace', name: 'searched', description: 'Tools in the searched namespace.', tools: [functionTool] }],
      },
    ],
  });
  assertEquals((payload.input[0] as { tools: Array<{ description: string }> }).tools[0]?.description, '');
});

test('preserves nullable top-level tools', () => {
  const payload: CanonicalOpenAIResponsesPayload = { model: 'gpt-test', tools: null, input: [] };
  assertEquals(mapOpenAIResponsesTools(payload, tool => tool), payload);
});
