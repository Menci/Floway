import { test } from 'vitest';

import { buildCustomUpstreamRecord, requestAppWithWarmModels as requestApp, setupAppTest, sseResponse } from '../../../test-utils/app.ts';
import { flushBackground } from '../../../test-utils/background-tracker.ts';
import type { OpenAIResponsesResult } from '@floway-dev/protocols/openai-responses';
import { assert, assertEquals, withMockedFetch } from '@floway-dev/test-utils';

type TargetApi = 'openaiChatCompletions' | 'anthropicMessages';
interface WireTool { name?: string; description?: string; function?: { name: string; description?: string } }
interface WireRequest {
  tools?: WireTool[];
  tool_choice?: unknown;
}
const namespace = {
  type: 'namespace', name: 'payments', description: 'Read-only access. Never charge the account.',
  tools: [
    { type: 'function', name: 'read', description: 'Read account details.', parameters: { type: 'object', properties: {} } },
    { type: 'function', name: 'charge', description: 'Charge an account.', parameters: { type: 'object', properties: {} } },
  ],
};
const setup = async (target: TargetApi) => await setupAppTest({
  copilotUpstream: buildCustomUpstreamRecord({
    config: {
      baseUrl: 'https://custom.example.com', authStyle: 'none', ingressHeadersRules: [], endpoints: { [target]: {} },
    },
  }),
});

const toolCallResponse = (target: TargetApi, name: string): Response => {
  if (target === 'openaiChatCompletions') {
    const base = { id: 'chat_test', object: 'chat.completion.chunk', created: 0, model: 'model' };
    return sseResponse([
      { data: { ...base, choices: [{ index: 0, delta: { role: 'assistant', tool_calls: [{ index: 0, id: 'call_read', type: 'function', function: { name, arguments: '{}' } }] }, finish_reason: null }] } },
      { data: { ...base, choices: [{ index: 0, delta: {}, finish_reason: 'tool_calls' }], usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 } } },
      { data: '[DONE]' },
    ]);
  }
  return sseResponse([
    { data: { type: 'message_start', message: { id: 'msg_test', type: 'message', role: 'assistant', model: 'model', content: [], stop_reason: null, stop_sequence: null, usage: { input_tokens: 1, output_tokens: 0 } } } },
    { data: { type: 'content_block_start', index: 0, content_block: { type: 'tool_use', id: 'call_read', name, input: {} } } },
    { data: { type: 'content_block_delta', index: 0, delta: { type: 'input_json_delta', partial_json: '{}' } } },
    { data: { type: 'content_block_stop', index: 0 } },
    { data: { type: 'message_delta', delta: { stop_reason: 'tool_use', stop_sequence: null }, usage: { output_tokens: 1 } } },
    { data: { type: 'message_stop' } },
  ]);
};

for (const target of ['openaiChatCompletions', 'anthropicMessages'] as const) {
  for (const representation of ['Standard', 'Standard carrier'] as const) {
    for (const mode of ['auto', 'required'] as const) {
      test.each(['callable', 'namespace'] as const)(`HTTP ${representation} preserves namespace allowed_tools and descriptions on final ${target} wire (${mode}, %s selector)`, async selection => {
        const { apiKey } = await setup(target);
        const selector = selection === 'namespace' ? { type: 'namespace', name: 'payments' }
          : { type: 'function', namespace: 'payments', name: 'read' };
        const choice = { type: 'allowed_tools', mode, tools: [selector] };
        const input = [{ type: 'message', role: 'user', content: 'Read my account.' }];
        const payload = { model: 'model', stream: false, store: false, tool_choice: choice, ...(representation !== 'Standard' ? { input: [{ type: 'additional_tools', role: 'developer', tools: [namespace] }, ...input] } : { input, tools: [namespace] }) };
        const wire: WireRequest[] = [];
        await withMockedFetch(async request => {
          if (new URL(request.url).pathname === '/v1/models') return Response.json({ data: [{ id: 'model' }] });
          assertEquals(new URL(request.url).pathname, target === 'openaiChatCompletions' ? '/v1/chat/completions' : '/v1/messages');
          const body = await request.json() as WireRequest;
          wire.push(body);
          return toolCallResponse(target, 'payments_read');
        }, async () => {
          const response = await requestApp('/v1/responses', { method: 'POST', headers: { authorization: `Bearer ${apiKey.key}`, 'content-type': 'application/json' }, body: JSON.stringify(payload) });
          const resource = await response.json() as OpenAIResponsesResult;
          assertEquals(response.status, 200);
          assertEquals(resource.status, 'completed');
          assertEquals(resource.tool_choice, choice);
          const call = resource.output.find(item => item.type === 'function_call');
          assert(call?.type === 'function_call');
          assertEquals([call.name, call.namespace], ['read', 'payments']);
          await flushBackground();
        });
        assertEquals(wire.length, 1, 'the final provider serializer must actually run once');
        const selected = selection === 'namespace' ? namespace.tools : namespace.tools.slice(0, 1);
        assertEquals(wire[0].tools?.map(tool => tool.function?.name ?? tool.name), selected.map(tool => `payments_${tool.name}`));
        assertEquals(wire[0].tools?.map(tool => tool.function?.description ?? tool.description), selected.map(tool => `${namespace.description}\n\n${tool.description}`));
        assertEquals(wire[0].tool_choice, target === 'openaiChatCompletions' ? mode : { type: mode === 'required' ? 'any' : 'auto' });
      });
    }
  }
}
