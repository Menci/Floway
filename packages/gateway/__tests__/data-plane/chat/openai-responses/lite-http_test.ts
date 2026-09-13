import { test } from 'vitest';

import { buildCodexUpstreamRecord, codexModels, parseSSEText, requestApp, setupAppTest, sseOpenAIResponsesResponse } from '../../../test-utils/app.ts';
import { OPENAI_RESPONSES_LITE_HEADER } from '@floway-dev/protocols/openai-responses';
import { assert, assertEquals, jsonResponse, withMockedFetch } from '@floway-dev/test-utils';

const setupCodex = async () => {
  const context = await setupAppTest();
  await context.repo.upstreams.save({ ...context.copilotUpstream, enabled: false });
  await context.repo.upstreams.save(buildCodexUpstreamRecord());
  return context;
};

const catalog = () => jsonResponse({ models: codexModels([{ slug: 'gpt-6-astra' }]).models.map(model => ({ ...model, use_responses_lite: true })) });

test.each([false, true])('native Codex Lite HTTP retains the complete request and continuation with stream=%s', async stream => {
  const { apiKey } = await setupCodex();
  const requests: Record<string, unknown>[] = [];
  const prefix = [
    {
      type: 'additional_tools', role: 'developer', id: 'at_native', tools: [
        { type: 'namespace', name: 'functions', tools: [{ type: 'function', name: 'lookup', async: true, parameters: { type: 'object', properties: { query: { type: 'string' } } } }] },
        { type: 'custom', name: 'run_query', async: true, format: { type: 'text' } },
      ], vendor_extension: { retained: true },
    },
    { type: 'message', role: 'developer', id: 'msg_native', content: [{ type: 'input_text', text: 'Keep the prefix.', prompt_cache_breakpoint: { mode: 'always' } }] },
    { type: 'message', role: 'user', content: [{ type: 'input_text', text: 'Look this up.' }, { type: 'input_image', image_url: 'https://example.test/image.png', detail: 'original' }] },
    { type: 'vendor:context', id: 'vendor_context', opaque: { retained: [1, false, null] } },
  ];
  const options = {
    reasoning: { effort: 'high', summary: 'detailed', vendor_setting: 'retained' },
    text: { verbosity: 'low', format: { type: 'json_schema', name: 'answer', schema: { type: 'object' }, strict: true } },
    parallel_tool_calls: false,
    tool_choice: { type: 'allowed_tools', mode: 'auto', tools: [{ type: 'function', name: 'lookup' }] },
    prompt_cache_options: { ttl: '30m', mode: 'explicit' },
    vendor_option: { retained: true },
  };
  const toolCall = { type: 'function_call', id: 'fc_native', call_id: 'call_native', name: 'lookup', arguments: '{"query":"weather"}', status: 'completed', vendor_result: true };
  const continuation = [
    { type: 'configuration_update', reasoning: { effort: 'xhigh' }, vendor_configuration: true },
    { type: 'additional_tools', role: 'developer', id: 'at_later', tools: [{ type: 'function', name: 'summarize', async: true }] },
    { type: 'function_call_output', call_id: 'call_native', output: 'Lookup complete.', vendor_output: true },
  ];
  await withMockedFetch(async request => {
    const { pathname } = new URL(request.url);
    if (pathname === '/backend-api/codex/models') return catalog();
    if (pathname !== '/backend-api/codex/responses') throw new Error(`Unhandled fetch ${request.url}`);
    assertEquals(request.headers.get(OPENAI_RESPONSES_LITE_HEADER), 'true');
    requests.push(JSON.parse(await request.text()) as Record<string, unknown>);
    const response = sseOpenAIResponsesResponse({
      id: `resp_upstream_${requests.length}`, object: 'response', model: 'gpt-6-astra', status: 'completed',
      output: requests.length === 1 ? [toolCall] : [], vendor_response: { retained: true },
    });
    response.headers.set('x-request-id', 'upstream-request-id');
    response.headers.set('x-vendor-result', 'retained');
    return response;
  }, async () => {
    const headers = { authorization: `Bearer ${apiKey.key}`, 'content-type': 'application/json', [OPENAI_RESPONSES_LITE_HEADER]: 'true' };
    const response = await requestApp('/v1/responses', { method: 'POST', headers, body: JSON.stringify({ model: 'gpt-6-astra', input: prefix, stream, store: true, ...options }) });
    assertEquals(response.status, 200);
    assertEquals(response.headers.get('x-request-id'), 'upstream-request-id');
    assertEquals(response.headers.get('x-vendor-result'), 'retained');
    const first = stream
      ? (JSON.parse(parseSSEText(await response.text()).find(frame => frame.event === 'response.completed')!.data) as { response: Record<string, unknown> }).response
      : await response.json() as Record<string, unknown>;
    assertEquals(first.vendor_response, { retained: true });
    assert(Array.isArray(first.output));
    assertEquals(first.output.filter(item => item.type === 'function_call'), [toolCall]);
    assert(typeof first.id === 'string');
    const next = await requestApp('/v1/responses', { method: 'POST', headers, body: JSON.stringify({ model: 'gpt-6-astra', input: continuation, previous_response_id: first.id, ...options }) });
    assertEquals(next.status, 200);
    await next.text();
    assertEquals(requests.length, 2);
    assertEquals(requests[0].input, prefix);
    assertEquals(requests[1].input, [...prefix, toolCall, ...continuation]);
    assertEquals(requests[1].previous_response_id, undefined);
    for (const request of requests) {
      for (const [key, value] of Object.entries(options)) assertEquals(request[key], value);
      assertEquals(request.tools, undefined);
      assertEquals(request.instructions, undefined);
      assertEquals(request.stream, true);
    }
    assertEquals(first.tools, prefix[0]!.tools);
  });
});

test.each(['/v1/responses', '/v1/responses/compact'])('native Codex Lite %s preserves upstream error bytes, status and headers', async path => {
  const { apiKey } = await setupCodex();
  const upstreamBody = ' {"error":{"type":"invalid_request_error","code":"future_code","message":"Unsupported vendor option","vendor_error":true}}\n';
  let calls = 0;
  await withMockedFetch(async request => {
    const { pathname } = new URL(request.url);
    if (pathname === '/backend-api/codex/models') return catalog();
    assertEquals(pathname, path === '/v1/responses' ? '/backend-api/codex/responses' : '/backend-api/codex/responses/compact');
    assertEquals(request.headers.get(OPENAI_RESPONSES_LITE_HEADER), 'true');
    calls += 1;
    return new Response(upstreamBody, { status: 422, headers: { 'content-type': 'application/json', 'x-request-id': 'upstream-error', 'x-vendor-error': 'retained' } });
  }, async () => {
    const response = await requestApp(path, { method: 'POST', headers: { authorization: `Bearer ${apiKey.key}`, 'content-type': 'application/json', [OPENAI_RESPONSES_LITE_HEADER]: 'true' }, body: JSON.stringify({ model: 'gpt-6-astra', input: [{ type: 'additional_tools', role: 'developer', tools: [] }], stream: true }) });
    assertEquals(response.status, 422);
    assertEquals(response.headers.get('content-type'), 'application/json');
    assertEquals(response.headers.get('x-request-id'), 'upstream-error');
    assertEquals(response.headers.get('x-vendor-error'), 'retained');
    assertEquals(await response.text(), upstreamBody);
    assertEquals(calls, 1);
  });
});
