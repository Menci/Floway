// Images' pipeline, assembled. `compose` derives the entry contract and rejects an array that
// cannot work, so most of what this file establishes is established by the assembly succeeding
// at all — and what is worth writing down is the contract it derives and the keys it cannot see.
//
// One thing no assertion here can reach, and the reason the route table must keep serving this
// family the old way until it is settled: both endpoints accept `stream: true` and answer with
// an SSE sequence of partial images, while this pipeline carries a parsed JSON body and nothing
// else. Such a request reaches the upstream, spends it, and comes back as the 502 the ending
// stage synthesizes for a body the protocol cannot read. Carrying it needs a stream of protocol
// frames in the fact space, which is the work the first streaming family brings with it.
// https://github.com/openai/openai-openapi/blob/a3276900e58b8b2a92e0cb087cd2e6e005f58458/openapi.yaml#L13077-L13086

import { describe, expect, it } from 'vitest';

import { imagesServePipeline, type ImagesServeEntry } from '../../src/data-plane/images/pipeline.ts';
import type { CanonicalImagesRequest } from '@floway-dev/protocols/images';

const generations: CanonicalImagesRequest = {
  operation: 'generations',
  parameters: { prompt: 'a shiba in space' },
};

const edits: CanonicalImagesRequest = {
  operation: 'edits',
  images: [{ kind: 'reference', reference: { file_id: 'file-source' } }],
  parameters: { prompt: 'replace the sky' },
};

describe('the images pipeline', () => {
  it('assembles both endpoints as one array, and asks its caller for what the descending stages need', () => {
    expect([...imagesServePipeline(generations).entryNeeds].sort()).toEqual(['serve.model']);
    expect([...imagesServePipeline(edits).entryNeeds].sort()).toEqual(['serve.model']);
  });

  // `callImagesUpstream` reads `request.images.canonical` and `ingress.http.headers`, and the
  // derived contract mentions neither. That is not this family's defect: a stage whose only
  // trait is `return` declares no request side at all, by ruling — "when it short-circuits,
  // only `provides`" — so assembly cannot see what an ending stage reads, and every family's
  // ending stage reads something.
  //
  // Written as a test rather than a comment because the hole has a consequence: a caller who
  // omits either key gets a runtime failure at the deepest stage instead of the assembly error
  // the entry contract exists to produce.
  it('cannot see what its ending stage reads, because a return-only stage declares no needs', () => {
    const derived = imagesServePipeline(generations).entryNeeds;
    expect(derived).not.toContain('request.images.canonical');
    expect(derived).not.toContain('ingress.http.headers');
  });

  // What covers that hole, and the reason it is a gap rather than a break: the entry type names
  // all three, so the caller `entryNeeds` would have let through does not compile.
  it('names every key a caller must bring in its entry type', () => {
    const entry: ImagesServeEntry = {
      'ingress.http.headers': [['content-type', 'application/json']],
      'request.images.canonical': generations,
      'serve.model': 'gpt-image-1',
    };
    expect(Object.keys(entry).sort()).toEqual(['ingress.http.headers', 'request.images.canonical', 'serve.model']);

    // @ts-expect-error — dropping one of them is a compile error, which is the statement this
    // makes; the assertion below only keeps the binding from being unused.
    const incomplete: ImagesServeEntry = { 'serve.model': 'gpt-image-1' };
    expect(Object.keys(incomplete)).toEqual(['serve.model']);
  });
});
