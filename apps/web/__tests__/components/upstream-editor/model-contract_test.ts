import { describe, expect, it } from 'vitest';

import { discoveredModelsFromResponse } from '../../../src/components/upstream-editor/data';
import { modelsAreValid } from '../../../src/components/upstream-editor/model-detail';

describe('custom discovered model projection', () => {
  it('maps fixed kinds to their own endpoint families', () => {
    const models = discoveredModelsFromResponse({
      kind: 'custom',
      data: [
        { id: 'speech', kind: 'transcription' },
        { id: 'ranker', kind: 'rerank' },
      ],
    }, { chatCompletions: {} });

    expect(models[0]?.endpoints).toEqual({ audioTranscriptions: {} });
    expect(models[1]?.endpoints).toEqual({ rerank: {} });
  });

  it('gives a row that declares no kind the configured map the gateway gives it', () => {
    const models = discoveredModelsFromResponse({
      kind: 'custom',
      data: [{ id: 'bge-m3' }, { id: 'talker', kind: 'chat' }],
    }, { embeddings: {} });

    expect(models[0]?.endpoints).toEqual({ embeddings: {} });
    expect(models[1]?.endpoints).toEqual({ embeddings: {} });
  });

  it('projects every discovered row into a shape the gateway accepts', () => {
    const models = discoveredModelsFromResponse({
      kind: 'custom',
      data: [
        { id: 'talker', kind: 'chat' },
        { id: 'painter', kind: 'image' },
        { id: 'speech', kind: 'transcription' },
        { id: 'ranker', kind: 'rerank' },
      ],
    }, { chatCompletions: {} });

    expect(modelsAreValid(models)).toBe(true);
  });
});

describe('manual model validation', () => {
  it('rejects the same incomplete identities and endpoint contracts as the gateway', () => {
    expect(modelsAreValid([{ upstreamModelId: '', kind: 'chat', endpoints: { chatCompletions: {} } }])).toBe(false);
    expect(modelsAreValid([{ upstreamModelId: 'ranker', kind: 'rerank', endpoints: { rerank: {} } }])).toBe(false);
    expect(modelsAreValid([{
      upstreamModelId: 'ranker',
      kind: 'rerank',
      endpoints: { rerank: {} },
      rerankTarget: { protocol: 'cohere-v2' },
    }])).toBe(true);
  });
});
