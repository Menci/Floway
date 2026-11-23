import { expect, test } from 'vitest';

import { facts, fixture } from './fixture.ts';
import { jsonHttpResponse } from '../../../../../src/data-plane/pipeline/edge-http.ts';
import type { GatewayHttpFacts } from '../../../../../src/data-plane/pipeline/host.ts';
import type { GatewayServices } from '../../../../../src/data-plane/pipeline/services.ts';
import { executeAlphaSearchSubRun } from '../../../../../src/data-plane/tools/web-search/alpha-search/execution.ts';
import type { WebSearchCallIR } from '../../../../../src/data-plane/tools/web-search/operations.ts';
import type { HttpResponseFacts } from '@floway-dev/http';
import { Bytes, compose, defineEnding, type RunEvent, run } from '@floway-dev/pipeline';

const execute = (http: HttpResponseFacts, args: Parameters<typeof executeAlphaSearchSubRun>[2]) => {
  const test = fixture(() => http);
  const events: RunEvent[] = [];
  type Output = { readonly 'response.tool': WebSearchCallIR };
  const pipeline = compose<GatewayHttpFacts, Output, GatewayServices>('test.web-search-tool', {
    stages: [],
    ending: defineEnding<GatewayHttpFacts, Output, {}, GatewayServices>({
      name: 'executeSearch',
      request: { needs: ['request.http'] },
      return: { provides: ['response.tool'] },
      execute: async (input, _into, env) => ({ 'response.tool': await executeAlphaSearchSubRun(env, input, args) }),
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
  const tool = execute(jsonHttpResponse(200, {
    encrypted_output: 'opaque',
    output: 'rendered output',
    results: [{ type: 'text_result', ref_id: 'turn0search0', url: 'https://example.com', title: 'Example', domain: 'example.com', future: true }],
  }, 0), base);
  const { 'response.tool': ir } = await tool.result;
  expect(ir.outputText).toBe('rendered output');
  expect(ir.results).toEqual([{ type: 'text_result', url: '', title: 'OpenAI search output', snippet: 'rendered output' }]);
  expect(tool.receive.mock.calls[0]?.[0]['request.payload']).toEqual({ id: base.sessionId, input: base.input, commands: base.commands, settings: base.settings });
  expect(await tool.done).toEqual({ ok: true });
  expect(tool.events).toContainEqual(expect.objectContaining({ k: 'enter', edge: 'subrun', pipeline: 'alpha-search.ingress' }));
  expect(tool.usage).toEqual([expect.objectContaining({ model: 'search-model', requests: 1 })]);
});

test('the tool sub-run exposes the upstream failure without local fallback', async () => {
  const tool = execute({ ...jsonHttpResponse(503, null, 0), body: Bytes.fromUtf8('unavailable') }, base);
  await expect(tool.result).rejects.toThrow('OpenAI search upstream returned HTTP 503: unavailable');
  expect(await tool.done).toMatchObject({ ok: false });
});

test('the tool sub-run exposes a cascaded Floway capability error as exact model-facing output', async () => {
  const message = 'The configured web search provider does not implement OpenAI search feature `commands.image_query`.';
  const tool = execute(jsonHttpResponse(500, {
    error: { type: 'internal_error', name: 'UnsupportedLocalWebSearchFeatureError', message },
  }, 0), { ...base, commands: { image_query: [{ q: 'cat' }] }, input: [], action: { type: 'search', query: 'image_query' } });
  const { 'response.tool': ir } = await tool.result;
  expect(ir.outputText).toBe(message);
  expect(ir.results).toEqual([{ type: 'text_result', url: '', title: 'Unsupported search feature', snippet: message }]);
  expect(await tool.done).toEqual({ ok: true });
});
