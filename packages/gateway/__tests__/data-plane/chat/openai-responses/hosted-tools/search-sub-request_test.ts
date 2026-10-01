import { expect, test } from 'vitest';

import type { WebSearchRequest } from '../../../../../src/data-plane/chat/openai-responses/hosted-tools/search-sub-request/facts.ts';
import { runWebSearchSubRequest } from '../../../../../src/data-plane/chat/openai-responses/hosted-tools/search-sub-request.ts';
import { initDumpBroker, initDumpStore } from '../../../../../src/dump/registry.ts';
import { openRunDump } from '../../../../../src/dump/run-sink.ts';
import { initRepo } from '../../../../../src/repo/index.ts';
import type { ApiKey } from '../../../../../src/repo/types.ts';
import { eventsOf, installDumpStubs } from '../../../../dump/test-fixtures.ts';
import { InMemoryRepo } from '../../../../repo/memory.ts';
import { stubAlphaSearchCandidate } from '../../../../test-utils/alpha-search-provider.ts';
import { flushBackground, trackBackground } from '../../../../test-utils/background-tracker.ts';
import { mockGatewayCtx } from '../../../../test-utils/gateway-ctx.ts';
import { createRunReader, type DumpEvent } from '@floway-dev/pipeline';

const apiKey: ApiKey = { id: 'search-key', userId: 1, name: 'Search key', key: 'floway-search-key', serverSecret: '00'.repeat(32), createdAt: '2026-01-01T00:00:00Z', upstreamIds: null, deletedAt: null, dumpRetentionSeconds: 3600, openaiResponsesRetentionSeconds: 0 };
const request: WebSearchRequest = {
  commands: { search_query: [{ q: 'pipeline streams' }] }, toolName: 'web_search', iterationCount: 1,
  filters: { allowedDomains: ['example.com'], maxResults: 20 }, includeSearchActionSources: true,
  settings: { search_context_size: 'medium' }, input: [{ type: 'message', role: 'user', content: [{ type: 'input_text', text: 'Find the documentation' }] }],
};

for (const failed of [false, true]) {
  test(`web search records backend content before dispatch and closes its ${failed ? 'failed' : 'successful'} child run`, async () => {
    initRepo(new InMemoryRepo());
    const dumps = installDumpStubs(initDumpStore, initDumpBroker);
    const dump = openRunDump(apiKey, { method: 'POST', path: '/v1/responses', body: { bytes: new Uint8Array(), streamError: null } }, trackBackground, true, { upstreamCallStartedAt: null, firstOutputTokenAt: null });
    const parent = mockGatewayCtx({ dump, backgroundScheduler: trackBackground });
    const fault = new Error('search transport failed', { cause: new Error('socket reset') });
    let dispatched = false;
    const invocation = runWebSearchSubRequest(parent, request, {
      session: { pageCache: new Map(), getProvider: () => { throw new Error('local provider must not dispatch in alpha mode'); }, apiKeyId: apiKey.id },
      alpha: {
        sessionId: 'search-session', resolveCandidate: async () => stubAlphaSearchCandidate(async body => {
          dispatched = true;
          expect(body).toEqual({ id: 'search-session', commands: request.commands, settings: request.settings, input: request.input });
          expect(Object.isFrozen(body.commands)).toBe(true);
          if (failed) throw fault;
          return new Response(JSON.stringify({ output: 'documentation' }), { headers: { 'content-type': 'application/json' } });
        }),
      },
    });
    if (failed) await expect(invocation).rejects.toBe(fault);
    else expect(await invocation).toMatchObject({ outputText: 'documentation' });
    expect(dispatched).toBe(true);
    dump?.finalize(200, 0);
    await flushBackground();
    expect(dumps.stored).toHaveLength(2);
    expect(dumps.stored.filter(item => item.record.meta.path === '/v1/responses')).toHaveLength(1);
    const record = dumps.stored.find(item => item.record.meta.path !== '/v1/responses')!.record;
    expect(record.meta.path).toBe('/alpha/search');
    expect(record.meta.status).toBe(failed ? 500 : 200);
    const read = createRunReader();
    const decoded = eventsOf(record).map(event => read(event as unknown as DumpEvent));
    const entered = decoded.find(event => event?.facts && 'request.webSearch.canonical' in event.facts);
    expect(entered?.facts?.['request.webSearch.canonical']).toEqual(request);
    expect(decoded).toContainEqual(expect.objectContaining({ facts: expect.objectContaining({ 'request.provider.payload': { id: 'search-session', commands: request.commands, settings: request.settings, input: request.input } }) }));
    expect(new TextDecoder().decode(record.events)).not.toContain('searchCall');
  });
}
