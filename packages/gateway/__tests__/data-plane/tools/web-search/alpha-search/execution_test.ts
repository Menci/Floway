import { expect, test } from 'vitest';

import { facts, fixture } from './fixture.ts';
import { GATEWAY_HTTP_ENTRY, type GatewayHttpFacts } from '../../../../../src/data-plane/pipeline/host.ts';
import type { GatewayServices } from '../../../../../src/data-plane/pipeline/services.ts';
import { executeAlphaSearchSubRun } from '../../../../../src/data-plane/tools/web-search/alpha-search/execution.ts';
import type { WebSearchCallIR } from '../../../../../src/data-plane/tools/web-search/operations.ts';
import { compose, defineEnding, type RunEvent, run } from '@floway-dev/pipeline';

const execute = (http: Response, args: Parameters<typeof executeAlphaSearchSubRun>[2]) => {
  const test = fixture(() => http);
  const events: RunEvent[] = [];
  type Output = { readonly 'response.tool': WebSearchCallIR };
  const pipeline = compose<GatewayHttpFacts & Output, GatewayServices>()('test.web-search-tool', {
    entry: GATEWAY_HTTP_ENTRY,
    exit: ['response.tool'],
    stages: [],
    ending: defineEnding<GatewayHttpFacts, Output, {}, GatewayServices>({
      name: 'executeSearch',
      request: { needs: GATEWAY_HTTP_ENTRY },
      return: { provides: ['response.tool'] },
      execute: async (input, scope) => ({ 'response.tool': await executeAlphaSearchSubRun(scope, input, args) }),
    }),
  });
  const handle = run(pipeline, facts, { services: test.services, events: event => events.push(event), finalizationTimeoutMs: 100 });
  return { ...test, ...handle, events };
};

const base: Parameters<typeof executeAlphaSearchSubRun>[2] = {
  sessionId: 'session-search',
  commands: { search_query: [{ q: 'Floway' }] },
  settings: { external_web_access: true },
  input: [{ type: 'message', role: 'user', content: 'Search' }],
  action: { type: 'search', query: 'Floway' },
};

test('the tool sub-run bills its own request and preserves model-facing output and opaque upstream context', async () => {
  const tool = execute(Response.json({
    encrypted_output: 'opaque',
    output: 'rendered output',
    results: [{ type: 'text_result', ref_id: 'turn0search0', url: 'https://example.com', title: 'Example', domain: 'example.com', future: true }],
  }), base);
  const { 'response.tool': ir } = await tool.result;
  expect(ir.outputText).toBe('rendered output');
  expect(ir.results).toEqual([{ type: 'text_result', url: '', title: 'OpenAI search output', snippet: 'rendered output' }]);
  const [[url, init]] = tool.receive.mock.calls;
  expect(await new Request(url, { method: 'POST', body: init.body as Uint8Array<ArrayBuffer> }).json()).toEqual({
    id: base.sessionId, input: base.input, commands: base.commands, settings: base.settings, model: 'search-model',
  });
  expect(await tool.done).toEqual({ ok: true });
  expect(tool.events).toContainEqual(expect.objectContaining({ k: 'enter', edge: 'subrun', pipeline: 'alpha-search.ingress' }));
  expect(tool.usage).toEqual([expect.objectContaining({ model: 'search-model', requests: 1 })]);
});

test('the tool sub-run exposes the upstream failure without local fallback', async () => {
  const tool = execute(new Response('unavailable', { status: 503 }), base);
  const { 'response.tool': ir } = await tool.result;
  expect(ir.outputText).toBe('OpenAI search upstream returned HTTP 503: unavailable');
  expect(await tool.done).toEqual({ ok: true });
  expect(tool.usage).toEqual([]);
});

test('the tool sub-run exposes a cascaded Floway capability error as exact model-facing output', async () => {
  const message = 'The configured web search provider does not implement OpenAI search feature `commands.image_query`.';
  const tool = execute(Response.json({
    error: { type: 'internal_error', name: 'UnsupportedLocalWebSearchFeatureError', message },
  }, { status: 500 }), { ...base, commands: { image_query: [{ q: 'cat' }] }, input: [], action: { type: 'search', query: 'image_query' } });
  const { 'response.tool': ir } = await tool.result;
  expect(ir.outputText).toBe(message);
  expect(ir.results).toEqual([{ type: 'text_result', url: '', title: 'Unsupported search feature', snippet: message }]);
  expect(await tool.done).toEqual({ ok: true });
});
