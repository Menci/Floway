import { describe, expect, it } from 'vitest';

import type { ApiKey, ControlPlaneModel } from '../../../src/api/types';
import {
  availableModels,
  defaultMaxOutputTokens,
  generationOptions,
  mergeWireBody,
  parseCustomJson,
  supportsImageInput,
} from '../../../src/components/playground/playground-logic';

const model = (id: string, upstreams: string[], extra: Partial<ControlPlaneModel> = {}): ControlPlaneModel => ({
  id, object: 'model', type: 'model', display_name: id, kind: 'chat', limits: {},
  endpoints: { responses: {}, chatCompletions: {}, messages: {} },
  upstreams: upstreams.map(upstream => ({ id: upstream, name: upstream, kind: 'custom', color: null })),
  ...extra,
});
const key = (upstream_ids: string[] | null): ApiKey => ({
  id: 'key', name: 'Key', key: 'secret', created_at: '', last_used_at: null,
  upstream_ids, dump_retention_seconds: null, responses_retention_seconds: 0,
});

describe('playground reachability', () => {
  it('resolves aliases and filters endpoint support', () => {
    const real = model('real', ['a'], { endpoints: { responses: {} } });
    const alias = model('alias', [], {
      endpoints: { responses: {} },
      aliasedFrom: { selection: 'first-available', targets: [{ target_model_id: 'real', rules: {} }] },
    });
    const chatOnly = model('chat', ['a'], { endpoints: { chatCompletions: {} } });
    expect(availableModels([real, alias, chatOnly], key(['a']), ['a'], 'responses').map(m => m.id))
      .toEqual(['real', 'alias']);
    expect(availableModels([real, alias], key(['b']), null, 'responses')).toEqual([]);
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

describe('parameters and capabilities', () => {
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
    expect(supportsImageInput(model('unknown', []))).toBe(true);
    expect(supportsImageInput(model('text', [], { chat: { modalities: { input: ['text'], output: ['text'] } } }))).toBe(false);
    expect(defaultMaxOutputTokens(model('limited', [], { limits: { max_output_tokens: 2048 } }))).toBe(2048);
  });
});
