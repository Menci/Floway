import { describe, expect, it } from 'vitest';

import {
  generationOptions,
  parseCustomJson,
  playgroundApisFor,
} from '../../../src/components/playground/request';
import { catalogModel } from '../../api/model-fixture';

describe('custom JSON', () => {
  it('offers every Playground protocol to any chat model', () => {
    // The playground calls the gateway, which translates. A model's own
    // endpoints describe what its upstream speaks, not what the caller may ask.
    expect(playgroundApisFor(catalogModel('chat', { endpoints: { openaiChatCompletions: {} } })))
      .toEqual(['openaiResponses', 'openaiChatCompletions', 'anthropicMessages', 'geminiGenerateContent']);
    expect(playgroundApisFor(catalogModel('embed', { kind: 'embedding', endpoints: { openaiEmbeddings: {} } }))).toEqual([]);
  });

  it('rejects invalid, non-object and reserved fields', () => {
    expect(parseCustomJson('openaiResponses', '{').error).toBe('invalid');
    expect(parseCustomJson('anthropicMessages', '[]').error).toBe('object');
    expect(parseCustomJson('openaiChatCompletions', '{"stream":false}')).toMatchObject({ error: 'reserved', fields: ['stream'] });
  });
});

describe('generation and capabilities', () => {
  it('names reasoning effort the way each protocol names it on the wire', () => {
    expect(generationOptions('openaiResponses', 'high')).toEqual({ reasoning: { effort: 'high' } });
    expect(generationOptions('openaiChatCompletions', 'high')).toEqual({ reasoning_effort: 'high' });
    expect(generationOptions('anthropicMessages', 'max', 100))
      .toEqual({ max_tokens: 100, thinking: { type: 'enabled' }, output_config: { effort: 'max' } });
  });
});
