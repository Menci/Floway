// OpenAI Embeddings' pipeline, assembled. `compose` derives the entry contract and rejects an
// array that cannot work, so most of what this file establishes is established by the
// assembly succeeding at all — and what is worth writing down is the entry contract it
// derives, including the two keys it cannot see.

import { describe, expect, it } from 'vitest';

import { openaiEmbeddingsServePipeline } from '../../src/data-plane/openai-embeddings/pipeline.ts';
import { move, run } from '@floway-dev/pipeline';

describe('the OpenAI Embeddings pipeline', () => {
  it('assembles, and asks its caller for what the descending stages need', () => {
    expect([...openaiEmbeddingsServePipeline.entryNeeds].sort()).toEqual([
      'ingress.http.headers',
      'ingress.openaiEmbeddings.encodingFormat',
      'request.openaiEmbeddings.canonical',
      'serve.model',
    ]);
  });

  it('names the entry key a caller did not bring, before any stage runs', async () => {
    await expect(run(openaiEmbeddingsServePipeline, move({ 'serve.model': 'text-embedding-3-small' }) as never, {}))
      .rejects.toThrow('run(openaiEmbeddingsServe): openaiEmbeddingsServe needs');
  });
});
