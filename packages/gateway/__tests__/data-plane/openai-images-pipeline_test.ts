// OpenAI Images' pipeline, assembled. `compose` derives the entry contract and rejects an array
// that cannot work, so most of what this file establishes is established by the assembly
// succeeding at all — and what is worth writing down is the contract it derives and the keys it
// cannot see.

import { describe, expect, it } from 'vitest';

import { type OpenAIImagesServeEntry } from '../../src/data-plane/openai-images/facts.ts';
import { openaiImagesServePipeline } from '../../src/data-plane/openai-images/pipeline.ts';
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
    expect([...openaiImagesServePipeline(generations).entryNeeds].sort()).toEqual(['ingress.http.headers', 'ingress.openaiImages.wantsStream', 'request.openaiImages.canonical', 'serve.model']);
    expect([...openaiImagesServePipeline(edits).entryNeeds].sort()).toEqual(['ingress.http.headers', 'ingress.openaiImages.wantsStream', 'request.openaiImages.canonical', 'serve.model']);
  });

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
