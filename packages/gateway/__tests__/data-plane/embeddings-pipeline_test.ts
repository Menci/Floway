// Embeddings' pipeline, assembled. `compose` derives the entry contract and rejects an
// array that cannot work, so most of what this file establishes is established by the
// assembly succeeding at all — and what is worth writing down is the entry contract it
// derives, including the two keys it cannot see.

import { describe, expect, it } from 'vitest';

import { embeddingsServePipeline } from '../../src/data-plane/embeddings/pipeline.ts';
import { move, run } from '@floway-dev/pipeline';

describe('the embeddings pipeline', () => {
  it('assembles, and asks its caller for what the descending stages need', () => {
    expect([...embeddingsServePipeline.entryNeeds].sort()).toEqual([
      'ingress.embeddings.encodingFormat',
      'serve.model',
    ]);
  });

  // Rerank records the same hole against `ingress.http.headers`; embeddings shows it twice
  // over, and the second one is the sharper case. A stage whose only trait is `return`
  // declares no request side at all, by ruling — "when it short-circuits, only `provides`"
  // — so assembly cannot see what an ending stage reads. `callEmbeddingsUpstream` reads
  // both the headers and the request payload, and neither reaches the entry contract.
  //
  // Rerank's edge happened to need `request.rerank.canonical` for rendering, which put it
  // in the contract for an unrelated reason. This family's edge needs only the encoding,
  // so nothing above the ending stage names the payload — and the pipeline that cannot run
  // without it does not ask for it. Written as a test rather than a comment because the
  // hole has a consequence: a caller who omits either key gets a runtime failure at the
  // deepest stage instead of an assembly error, and the entry contract exists to stop
  // exactly that. The type layer still catches it at the definition site, which is why
  // this is a gap and not a break.
  it('cannot see what an ending stage reads, because a return-only stage declares no needs', () => {
    expect(embeddingsServePipeline.entryNeeds).not.toContain('request.embeddings.canonical');
    expect(embeddingsServePipeline.entryNeeds).not.toContain('ingress.http.headers');
  });

  it('names the entry key a caller did not bring, before any stage runs', async () => {
    await expect(run(embeddingsServePipeline, move({ 'serve.model': 'text-embedding-3-small' }) as never, {}))
      .rejects.toThrow('run(embeddingsServe): embeddingsServe needs');
  });
});
