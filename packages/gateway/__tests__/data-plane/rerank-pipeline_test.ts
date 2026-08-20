// Rerank's pipeline, assembled. `compose` derives the entry contract and rejects an array
// that cannot work, so most of what this file establishes is established by the assembly
// succeeding at all — and what is worth writing down is the entry contract it derives,
// including the one key it cannot see.

import { describe, expect, it } from 'vitest';

import { failover } from '../../src/data-plane/pipeline/stages.ts';
import { rerankServePipeline } from '../../src/data-plane/rerank/pipeline.ts';
import { move, run } from '@floway-dev/pipeline';
import type { CanonicalRerankRequest } from '@floway-dev/protocols/rerank';

const request: CanonicalRerankRequest = {
  sourceProtocol: 'cohere-v2',
  raw: {},
  query: 'what is a pipeline',
  documents: ['one', 'two'],
};

describe('the rerank pipeline', () => {
  it('assembles, and asks its caller for what the descending stages need', () => {
    expect([...rerankServePipeline(request).entryNeeds].sort()).toEqual([
      'ingress.rerank.sourceProtocol',
      'request.rerank.canonical',
      'serve.model',
    ]);
  });

  // `callRerankUpstream` reads `ingress.http.headers`, and the entry contract does not
  // mention it. That is not this family's defect: a stage whose only trait is `return`
  // declares no request side at all, by ruling — "when it short-circuits, only `provides`"
  // — so assembly cannot see what an ending stage reads, and every family's ending stage
  // reads something.
  //
  // Written as a test rather than a comment because the hole has a consequence: a caller
  // who omits that key gets a runtime failure at the deepest stage instead of an assembly
  // error, and the entry contract exists to stop exactly that. The type layer still
  // catches it at the definition site, which is why this is a gap and not a break.
  it('cannot see what an ending stage reads, because a return-only stage declares no needs', () => {
    expect(rerankServePipeline(request).entryNeeds).not.toContain('ingress.http.headers');
  });

  // `failover` used to declare that it provides `response.http.body` for every family. Three
  // of the six never produce one — they read their answer to the end — so those pipelines
  // composed cleanly and then threw on the first real request, at the deepest stage, with a
  // message about a key their author had never written down.
  //
  // What a fork owns is a statement only the family can make, so it makes it. This asserts
  // the shape of that statement rather than the absence of a bug, because the absence of a
  // bug is what every one of these tests asserted before and none of them caught it.
  it('claims nothing on the way up when a family reads its answer to the end', () => {
    const reading = failover({ failed: () => false, owns: [] });
    expect(reading.through?.response.consumes).toEqual([]);
    expect(reading.through?.response.provides).toEqual([]);

    // And a family that streams claims the key it streams at, in both directions: every
    // attempt's is the fork's to release, and the one it adopts rides up with ownership.
    const streaming = failover({ failed: () => false, owns: ['response.http.body'] });
    expect(streaming.through?.response.consumes).toEqual(['response.http.body']);
    expect(streaming.through?.response.provides).toEqual(['response.http.body']);
  });

  // A live handle is never a fact, and the test for that is whether it can be rendered into
  // the dump. A `ModelCandidate` cannot: it carries the provider's instance, its fetcher and
  // its models cache. Putting one in the record deep-freezes all three, and the SWR cache
  // refresh the provider does on its own schedule then breaks — throwing under a module,
  // which every file here is, and failing silently anywhere that is not strict.
  it('carries a selector, so freezing the record cannot reach a live handle', () => {
    const instance = { cache: null as unknown };
    const candidate = { provider: { upstreamId: 'u', instance, modelsCache: { at: 1 } } };

    // What the record actually holds: data, and nothing that answers to a call.
    move({ 'route.attempt': { upstreamId: 'u', modelId: 'm', flags: [] } });
    expect(Object.isFrozen(instance)).toBe(false);
    expect(Object.isFrozen(candidate.provider.modelsCache)).toBe(false);

    // And what putting the candidate itself there would have done, so the difference is not
    // hypothetical — this is the shape the six families carried until the selector split.
    move({ 'route.candidate': candidate } as never);
    expect(Object.isFrozen(instance)).toBe(true);
    expect(() => { instance.cache = { refreshed: true }; }).toThrow(TypeError);
  });

  it('names the entry key a caller did not bring, before any stage runs', async () => {
    await expect(run(rerankServePipeline(request), move({ 'serve.model': 'rerank-v3' }) as never, {}))
      .rejects.toThrow('run(rerankServe): rerankServe needs');
  });
});
