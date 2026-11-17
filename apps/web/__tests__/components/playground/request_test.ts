import { describe, expect, it } from 'vitest';

import {
  defaultMaxOutputTokens,
  generationOptions,
  parseCustomJson,
  playgroundApisFor,
  supportsImageInput,
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

  it('always caps Anthropic Messages output, which requires the field on the wire', () => {
    expect(generationOptions('anthropicMessages', undefined, 2048)).toEqual({ max_tokens: 2048 });
    expect(generationOptions('openaiResponses', undefined)).toEqual({});
  });

  it('reads image and output limits conservatively', () => {
    expect(supportsImageInput(catalogModel('unknown', { upstreams: [] }))).toBe(true);
    expect(supportsImageInput(catalogModel('text', { upstreams: [],  chat: { modalities: { input: ['text'], output: ['text'] } } }))).toBe(false);
    expect(defaultMaxOutputTokens(catalogModel('limited', { upstreams: [],  limits: { max_output_tokens: 2048 } }))).toBe(2048);
  });
});
