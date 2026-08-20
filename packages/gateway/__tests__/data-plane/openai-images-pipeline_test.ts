// OpenAI Images' pipeline, assembled. `compose` derives the entry contract and rejects an array
// that cannot work, so most of what this file establishes is established by the assembly
// succeeding at all — and what is worth writing down is the contract it derives and the keys it
// cannot see.

import { describe, expect, it } from 'vitest';

import { openaiImagesServePipeline, type OpenAIImagesServeEntry } from '../../src/data-plane/openai-images/pipeline.ts';
import type { CanonicalOpenAIImagesRequest } from '@floway-dev/protocols/openai-images';

const generations: CanonicalOpenAIImagesRequest = {
  operation: 'generations',
  parameters: { prompt: 'a shiba in space' },
};

const edits: CanonicalOpenAIImagesRequest = {
  operation: 'edits',
  images: [{ kind: 'reference', reference: { file_id: 'file-source' } }],
  parameters: { prompt: 'replace the sky' },
};

describe('the OpenAI Images pipeline', () => {
  it('assembles both endpoints as one array, and asks its caller for what the descending stages need', () => {
    expect([...openaiImagesServePipeline(generations).entryNeeds].sort()).toEqual(['serve.model']);
    expect([...openaiImagesServePipeline(edits).entryNeeds].sort()).toEqual(['serve.model']);
  });

  // `callOpenAIImagesUpstream` reads `request.openaiImages.canonical`,
  // `ingress.openaiImages.wantsStream` and `ingress.http.headers`, and the derived contract
  // mentions none of them. That is not this family's defect: a stage whose only trait is
  // `return` declares no request side at all, by ruling — "when it short-circuits, only
  // `provides`" — so assembly cannot see what an ending stage reads, and every family's ending
  // stage reads something.
  //
  // Written as a test rather than a comment because the hole has a consequence: a caller who
  // omits any of them gets a runtime failure at the deepest stage instead of the assembly error
  // the entry contract exists to produce.
  it('cannot see what its ending stage reads, because a return-only stage declares no needs', () => {
    const derived = openaiImagesServePipeline(generations).entryNeeds;
    expect(derived).not.toContain('request.openaiImages.canonical');
    expect(derived).not.toContain('ingress.openaiImages.wantsStream');
    expect(derived).not.toContain('ingress.http.headers');
  });

  // What covers that hole, and the reason it is a gap rather than a break: the entry type names
  // all four, so the caller `entryNeeds` would have let through does not compile.
  it('names every key a caller must bring in its entry type', () => {
    const entry: OpenAIImagesServeEntry = {
      'ingress.http.headers': [['content-type', 'application/json']],
      'ingress.openaiImages.wantsStream': false,
      'request.openaiImages.canonical': generations,
      'serve.model': 'gpt-image-1',
    };
    expect(Object.keys(entry).sort()).toEqual([
      'ingress.http.headers',
      'ingress.openaiImages.wantsStream',
      'request.openaiImages.canonical',
      'serve.model',
    ]);

    // @ts-expect-error — dropping one of them is a compile error, which is the statement this
    // makes; the assertion below only keeps the binding from being unused.
    const incomplete: OpenAIImagesServeEntry = { 'serve.model': 'gpt-image-1' };
    expect(Object.keys(incomplete)).toEqual(['serve.model']);
  });
});
