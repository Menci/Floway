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
  messages?: Array<{ tool_calls?: Array<{ function: { name: string } }>; content?: string | Array<{ type: string; name?: string }> }>;
}
const replayNames = (request: WireRequest): string[] => request.messages?.flatMap(message =>
  message.tool_calls?.map(call => call.function.name)
  ?? (Array.isArray(message.content) ? message.content.flatMap(block => block.type === 'tool_use' && block.name !== undefined ? [block.name] : []) : [])) ?? [];

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
  test.each(['function', 'custom'] as const)(`HTTP ${target} selects a same-name %s and restores its kind without an alias`, async kind => {
    const { apiKey } = await setup(target);
    const tools = [{ type: 'function', name: 'read', parameters: { type: 'object' } }, { type: 'custom', name: 'read' }];
    const choice = { type: 'allowed_tools', mode: 'required', tools: [{ type: kind, name: 'read' }] };
    const wire: WireRequest[] = [];
    await withMockedFetch(async request => {
      if (new URL(request.url).pathname === '/v1/models') return Response.json({ data: [{ id: 'model' }] });
      assertEquals(new URL(request.url).pathname, target === 'openaiChatCompletions' ? '/v1/chat/completions' : '/v1/messages');
      wire.push(await request.json() as WireRequest);
      return toolCallResponse(target, 'read');
    }, async () => {
      const response = await requestApp('/v1/responses', {
        method: 'POST', headers: { authorization: `Bearer ${apiKey.key}`, 'content-type': 'application/json' },
        body: JSON.stringify({
          model: 'model', stream: false, store: false, tools, tool_choice: choice,
          input: [
            { type: 'function_call', name: 'read', call_id: 'past', arguments: '{}', status: 'completed' },
            { type: 'function_call_output', call_id: 'past', output: 'done' },
          ],
        }),
      });
      const body = await response.json() as OpenAIResponsesResult;
      assertEquals(response.status, 200, JSON.stringify(body));
      const call = body.output.find(item => item.type === 'function_call' || item.type === 'custom_tool_call');
      assert(call?.type === 'function_call' || call?.type === 'custom_tool_call');
      assertEquals([call.type, call.name, call.namespace], [kind === 'function' ? 'function_call' : 'custom_tool_call', 'read', undefined]);
      assertEquals(body.tool_choice, choice);
      await flushBackground();
    });
    assertEquals(wire.length, 1, 'the selected callable must reach the provider serializer');
    assertEquals(wire[0].tools?.map(tool => tool.function?.name ?? tool.name), ['read']);
    assertEquals(replayNames(wire[0]), ['read']);
  });

  test.each([
    { separator: '.', flatFirst: false }, { separator: '.', flatFirst: true },
    { separator: '__', flatFirst: false }, { separator: '__', flatFirst: true },
  ])(`HTTP ${target} keeps flat replay separate from explicit namespace replay (%j)`, async ({ separator, flatFirst }) => {
    const { apiKey } = await setup(target);
    const explicit = { type: 'function_call', namespace: 'files', name: 'read', call_id: 'explicit', arguments: '{}', status: 'completed' };
    const flat = { ...explicit, namespace: undefined, name: `files${separator}read`, call_id: 'flat' };
    const calls = flatFirst ? [flat, explicit] : [explicit, flat];
    const wire: WireRequest[] = [];
    await withMockedFetch(async request => {
      if (new URL(request.url).pathname === '/v1/models') return Response.json({ data: [{ id: 'model' }] });
      assertEquals(new URL(request.url).pathname, target === 'openaiChatCompletions' ? '/v1/chat/completions' : '/v1/messages');
      wire.push(await request.json() as WireRequest);
      return toolCallResponse(target, flat.name);
    }, async () => {
      const response = await requestApp('/v1/responses', {
        method: 'POST', headers: { authorization: `Bearer ${apiKey.key}`, 'content-type': 'application/json' },
        body: JSON.stringify({ model: 'model', stream: false, store: false, input: calls.flatMap(call => [call, { type: 'function_call_output', call_id: call.call_id, output: 'done' }]) }),
      });
      const body = await response.json() as OpenAIResponsesResult;
      assertEquals(response.status, 200, JSON.stringify(body));
      assertEquals(body.output.filter(item => item.type === 'function_call').map(item => [item.name, item.namespace]), [[flat.name, undefined]]);
      await flushBackground();
    });
    assertEquals(wire.length, 1, 'the provider serializer must observe the request');
    assertEquals(replayNames(wire[0]), flatFirst ? [flat.name, 'files_read'] : ['files_read', flat.name]);
  });

  test.each(['.', '__'])(`HTTP ${target} preserves a flat tool across stateless turns after its declaration is removed (%s)`, async separator => {
    const { apiKey } = await setup(target);
    const name = `files${separator}read`;
    const scoped = { type: 'namespace', name: 'files', tools: [{ type: 'function', name: 'read', parameters: { type: 'object' } }] };
    const wire: WireRequest[] = [];
    await withMockedFetch(async request => {
      if (new URL(request.url).pathname === '/v1/models') return Response.json({ data: [{ id: 'model' }] });
      assertEquals(new URL(request.url).pathname, target === 'openaiChatCompletions' ? '/v1/chat/completions' : '/v1/messages');
      wire.push(await request.json() as WireRequest);
      return toolCallResponse(target, wire.length === 1 ? name : 'files_read');
    }, async () => {
      const headers = { authorization: `Bearer ${apiKey.key}`, 'content-type': 'application/json' };
      const base = { model: 'model', stream: false, store: false };
      const first = await requestApp('/v1/responses', {
        method: 'POST', headers, body: JSON.stringify({ ...base, tools: [scoped, { type: 'function', name, parameters: { type: 'object' } }], input: 'Read the file.' }),
      });
      const firstBody = await first.json() as OpenAIResponsesResult;
      assertEquals(first.status, 200, JSON.stringify(firstBody));
      const call = firstBody.output.find(item => item.type === 'function_call');
      assert(call?.type === 'function_call');
      assertEquals([call.name, call.namespace], [name, undefined]);
      const second = await requestApp('/v1/responses', {
        method: 'POST', headers, body: JSON.stringify({ ...base, tools: [scoped], input: [...firstBody.output, { type: 'function_call_output', call_id: call.call_id, output: 'done' }] }),
      });
      const secondBody = await second.json() as OpenAIResponsesResult;
      assertEquals(second.status, 200, JSON.stringify(secondBody));
      assertEquals(secondBody.output.filter(item => item.type === 'function_call').map(item => [item.name, item.namespace]), [['read', 'files']]);
      await flushBackground();
    });
    assertEquals(wire.length, 2, 'both turns must reach the final provider serializer');
    assertEquals(replayNames(wire[1]), [name]);
    assertEquals(wire[1].tools?.map(tool => tool.function?.name ?? tool.name), ['files_read']);
  });

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

  for (const stream of [false, true]) {
    test(`HTTP ${target} returns typed 400 for invalid namespace/allowed_tools input before dispatch (stream ${stream})`, async () => {
      const { apiKey } = await setup(target);
      let calls = 0;
      const headers = { authorization: `Bearer ${apiKey.key}`, 'content-type': 'application/json' };
      await withMockedFetch(async request => {
        if (new URL(request.url).pathname === '/v1/models') return Response.json({ data: [{ id: 'model' }] });
        assertEquals(new URL(request.url).pathname, target === 'openaiChatCompletions' ? '/v1/chat/completions' : '/v1/messages');
        calls++;
        return Response.json({ error: { message: 'Valid control reached upstream', type: 'control' } }, { status: 418 });
      }, async () => {
        const base = { model: 'model', input: 'Read only.', stream, store: false, tools: [namespace] };
        const control = await requestApp('/v1/responses', { method: 'POST', headers, body: JSON.stringify(base) });
        assertEquals(control.status, 418);
        await control.text();
        assertEquals(calls, 1, 'valid control must prove the dispatch observer is on the route');
        for (const extra of [
          { tools: [{ type: 'function', name: 'read' }, { type: 'custom', name: 'read' }] },
          { tools: [{ type: 'function', name: 'read' }, { type: 'custom', name: 'read' }], tool_choice: { type: 'allowed_tools', mode: 'auto', tools: [{ type: 'function', name: 'read' }, { type: 'custom', name: 'read' }] } },
          { tools: [{ type: 'function', name: 'read' }], input: [{ type: 'additional_tools', role: 'developer', tools: [{ type: 'custom', name: 'read' }] }] },
          { tools: [{ type: 'function', name: 'read' }], input: [{ type: 'tool_search_output', tools: [{ type: 'custom', name: 'read' }] }] },
          { tools: [{ ...namespace, tools: [{ type: 'function', name: 'read' }, { type: 'custom', name: 'read' }] }] },
          { tools: [{ ...namespace, tools: null }] },
          { tools: [{ ...namespace, tools: [null] }] },
          { tools: [{ ...namespace, name: 123 }] },
          { tool_choice: { type: 'allowed_tools', mode: 'auto', tools: [{ type: 'function', name: 'payments.read' }] } },
          { tool_choice: { type: 'allowed_tools', mode: 'auto', tools: [{ type: 'function', name: 'payments__read' }] } },
          { tool_choice: { type: 'allowed_tools', mode: 'required', tools: [{ type: 'mcp', server_label: 'remote' }] } },
          { tool_choice: { type: 'function', namespace: 'payments', name: 'missing' } },
          { tool_choice: { type: 'custom', namespace: 'payments', name: 'read' } },
          { input: [{ type: 'function_call', namespace: 'payments', name: 'missing', call_id: 'past', arguments: '{}', status: 'completed' }], tool_choice: { type: 'function', namespace: 'payments', name: 'missing' } },
          { tool_choice: { type: 'allowed_tools', mode: 'required', tools: [] } },
          { tool_choice: { type: 'allowed_tools', mode: 'auto', tools: null } },
          { tool_choice: { type: 'allowed_tools', mode: 'future', tools: [{ type: 'function', namespace: 'payments', name: 'read' }] } },
          { tool_choice: { type: 'allowed_tools', mode: 'auto', tools: [{ type: 'function', namespace: 'payments', name: 'missing' }] } },
          { tool_choice: { type: 'allowed_tools', mode: 'auto', tools: [{ type: 'namespace', name: 'payments', extension: true }] } },
        ]) {
          const response = await requestApp('/v1/responses', { method: 'POST', headers, body: JSON.stringify({ ...base, ...extra }) });
          const body = await response.json() as { error: { type: string; code: string | null; message: string } };
          assertEquals(response.status, 400, JSON.stringify(body));
          assertEquals(body.error.type, 'invalid_request_error');
          assertEquals(body.error.code, null);
          assertEquals(calls, 1, 'invalid input must not reach the provider serializer');
        }
        await flushBackground();
      });
    });
  }
}

for (const target of ['openaiChatCompletions', 'anthropicMessages'] as const) {
  for (const topLevel of [false, true]) {
    test(`HTTP ${target} maps search-loaded history and namespace subsets once (top-level declarations ${topLevel})`, async () => {
      const { apiKey } = await setup(target);
      const tool = (name: string) => ({ type: 'namespace', name: 'files', description: 'File policy.', tools: [{ type: 'function', name, parameters: { type: 'object' } }] });
      const wire: WireRequest[] = [];
      await withMockedFetch(async request => {
        if (new URL(request.url).pathname === '/v1/models') return Response.json({ data: [{ id: 'model' }] });
        assertEquals(new URL(request.url).pathname, target === 'openaiChatCompletions' ? '/v1/chat/completions' : '/v1/messages');
        wire.push(await request.json() as WireRequest);
        return toolCallResponse(target, 'files_write');
      }, async () => {
        const response = await requestApp('/v1/responses', {
          method: 'POST', headers: { authorization: `Bearer ${apiKey.key}`, 'content-type': 'application/json' },
          body: JSON.stringify({
            model: 'model', stream: false, store: false,
            ...(topLevel ? { tools: [tool('read')] } : {}),
            input: [
              { type: 'tool_search_output', tools: [tool('write')] },
              { type: 'function_call', namespace: 'files', name: 'write', call_id: 'past', arguments: '{}', status: 'completed' },
              { type: 'function_call_output', call_id: 'past', output: 'done' },
            ],
            tool_choice: { type: 'allowed_tools', mode: 'auto', tools: [{ type: 'namespace', name: 'files' }] },
          }),
        });
        const body = await response.json() as OpenAIResponsesResult;
        assertEquals(response.status, 200, JSON.stringify(body));
        assertEquals(body.output.filter(item => item.type === 'function_call').map(item => [item.name, item.namespace]), [['write', 'files']]);
        await flushBackground();
      });
      assertEquals(wire.length, 1, 'the final provider serializer must run');
      assertEquals(wire[0].tools?.map(tool => tool.function?.name ?? tool.name), [...(topLevel ? ['files_read'] : []), 'files_write']);
      assert(JSON.stringify(wire[0].messages).includes('"name":"files_write"'), 'replay must reference the same declaration alias');
    });
  }
}
