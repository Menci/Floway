// Rerank's pipeline, assembled. `compose` derives the entry contract and rejects an array
// that cannot work, so most of what this file establishes is established by the assembly
// succeeding at all — and what is worth writing down is the entry contract it derives,
// including the one key it cannot see.

import { describe, expect, it } from 'vitest';

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

  it('names the entry key a caller did not bring, before any stage runs', async () => {
    await expect(run(rerankServePipeline(request), move({ 'serve.model': 'rerank-v3' }) as never, {}))
      .rejects.toThrow('run(rerankServe): rerankServe needs');
  });
});
