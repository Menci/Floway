// Search's pipeline, assembled. `compose` derives the entry contract and rejects an array
// that cannot work, so most of what this file establishes is established by the assembly
// succeeding at all — and what is worth writing down is the two contracts it derives, one per
// ending, plus the one it cannot derive at all.

import { describe, expect, it } from 'vitest';

import { searchServePipeline } from '../../src/data-plane/alpha-search/pipeline.ts';
import { mockGatewayCtx } from '../test-utils/gateway-ctx.ts';
import { move, run } from '@floway-dev/pipeline';

const pinned = { kind: 'upstream', upstreamId: 'up_alpha', model: 'gpt-search' } as const;

describe('the search pipeline', () => {
  it('assembles the local ending, and asks its caller for what the descending stages need', () => {
    expect([...searchServePipeline({ kind: 'local' }).entryNeeds].sort()).toEqual([
      'request.search.alphaSearch',
    ]);
  });

  it('requires the pinned request payload and admitted headers before entering its provider', () => {
    expect([...searchServePipeline(pinned).entryNeeds].sort()).toEqual(['ingress.http.headers', 'request.search.alphaSearch']);
  });

  it('names the entry key a caller did not bring, before any stage runs', async () => {
    await expect(run(searchServePipeline({ kind: 'local' }), move({}) as never, {}))
      .rejects.toThrow('run(searchServe): searchServe needs request.search.alphaSearch');
  });

  // A request with nothing to run reaches no backend at all: the parse stage answers instead
  // of descending, and what the assembly guarantees — that a short-circuit covers what the
  // edge needs — is what makes the run produce a rendered body, a status and a billed set
  // anyway. Settlement is unconditional, so the run still writes; a search that ran locally
  // simply names no billed entity.
  it('answers in band when there is nothing to run, and the edge renders that answer', async () => {
    const { facts } = await run(
      searchServePipeline({ kind: 'local' }),
      move({ 'request.search.alphaSearch': { commands: {} } }),
      { gateway: mockGatewayCtx({ wantsStream: false }), background: () => {} } as never,
    );
    expect(facts['response.http.status']).toBe(200);
    expect(facts['response.search.rendered']).toEqual({
      encrypted_output: null,
      output: 'No web search commands were provided. Populate at least one of `search_query`, `open`, or `find`.',
    });
    // Nothing was called that a model prices, and an empty set is how that is said.
    expect(facts['response.usage.billable']).toEqual([]);
  });
});
