import { describe, expect, it } from 'vitest';

import {
  defaultMaxOutputTokens,
  generationOptions,
  mergeWireBody,
  parseCustomJson,
  supportsImageInput,
} from '../../../src/components/playground/request';
import { catalogModel } from '../../api/model-fixture';

describe('custom JSON', () => {
  it('rejects invalid, non-object and reserved fields', () => {
    expect(parseCustomJson('openaiResponses', '{').error).toBe('invalid');
    expect(parseCustomJson('anthropicMessages', '[]').error).toBe('object');
    expect(parseCustomJson('openaiChatCompletions', '{"stream":false}')).toMatchObject({ error: 'reserved', fields: ['stream'] });
  });

  it('overrides generated wire fields', () => {
    expect(JSON.parse(mergeWireBody('{"model":"m","temperature":0.2}', { temperature: 0.9, seed: 2 })))
      .toEqual({ model: 'm', temperature: 0.9, seed: 2 });
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

  it('forwards an unknown reasoning effort rather than gating it', () => {
    expect(generationOptions('openaiChatCompletions', 'ludicrous')).toEqual({ reasoning_effort: 'ludicrous' });
  });

  it('reads image and output limits conservatively', () => {
    expect(supportsImageInput(catalogModel('unknown', { upstreams: [] }))).toBe(true);
    expect(supportsImageInput(catalogModel('text', { upstreams: [],  chat: { modalities: { input: ['text'], output: ['text'] } } }))).toBe(false);
    expect(defaultMaxOutputTokens(catalogModel('limited', { upstreams: [],  limits: { max_output_tokens: 2048 } }))).toBe(2048);
  });
});
