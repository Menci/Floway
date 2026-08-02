import { describe, expect, it } from 'vitest';

import {
  availableModels,
  defaultMaxOutputTokens,
  generationOptions,
  mergeWireBody,
  parseCustomJson,
  supportsImageInput,
} from '../../../src/components/playground/playground-logic';
import { aliasModel, chatModel } from '../../api/model-fixture';

describe('playground reachability', () => {
  it('keeps every reachable chat model available across source protocols', () => {
    const real = chatModel('real', { upstreams: ['a'],  endpoints: { responses: {} } });
    const alias = aliasModel('alias', ['real'], { endpoints: { responses: {} } });
    const chatOnly = chatModel('chat', { upstreams: ['a'],  endpoints: { chatCompletions: {} } });
    expect(availableModels([real, alias, chatOnly], ['a']).map(m => m.id))
      .toEqual(['real', 'alias', 'chat']);
    expect(availableModels([real, alias], ['b'])).toEqual([]);
  });
});

describe('custom JSON', () => {
  it('rejects invalid, non-object and reserved fields', () => {
    expect(parseCustomJson('responses', '{').error).toBe('invalid');
    expect(parseCustomJson('messages', '[]').error).toBe('object');
    expect(parseCustomJson('chatCompletions', '{"stream":false}')).toMatchObject({ error: 'reserved', fields: ['stream'] });
  });

  it('overrides generated wire fields', () => {
    expect(JSON.parse(mergeWireBody('{"model":"m","temperature":0.2}', { temperature: 0.9, seed: 2 })))
      .toEqual({ model: 'm', temperature: 0.9, seed: 2 });
  });
});

describe('generation and capabilities', () => {
  it('names reasoning effort the way each protocol names it on the wire', () => {
    expect(generationOptions('responses', 'high')).toEqual({ reasoning: { effort: 'high' } });
    expect(generationOptions('chatCompletions', 'high')).toEqual({ reasoning_effort: 'high' });
    expect(generationOptions('messages', 'max', 100))
      .toEqual({ max_tokens: 100, thinking: { type: 'enabled' }, output_config: { effort: 'max' } });
  });

  it('always caps Messages output, which requires the field on the wire', () => {
    expect(generationOptions('messages', undefined, 2048)).toEqual({ max_tokens: 2048 });
    expect(generationOptions('responses', undefined)).toEqual({});
  });

  it('forwards an unknown reasoning effort rather than gating it', () => {
    expect(generationOptions('chatCompletions', 'ludicrous')).toEqual({ reasoning_effort: 'ludicrous' });
  });

  it('reads image and output limits conservatively', () => {
    expect(supportsImageInput(chatModel('unknown', { upstreams: [] }))).toBe(true);
    expect(supportsImageInput(chatModel('text', { upstreams: [],  chat: { modalities: { input: ['text'], output: ['text'] } } }))).toBe(false);
    expect(defaultMaxOutputTokens(chatModel('limited', { upstreams: [],  limits: { max_output_tokens: 2048 } }))).toBe(2048);
  });
});
