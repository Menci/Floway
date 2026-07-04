import { describe, expect, test } from 'vitest';

import { stripUnsupportedFields } from './strip-unsupported-fields.ts';
import type { ChatCompletionsBoundaryCtx } from './types.ts';
import type { ChatCompletionsPayload } from '@floway-dev/protocols/chat-completions';
import type { ProviderModel } from '@floway-dev/provider';

const mkCtx = (payload: Partial<ChatCompletionsPayload>): ChatCompletionsBoundaryCtx => ({
  payload: { model: 'm', messages: [{ role: 'user', content: 'hi' }], ...payload } as ChatCompletionsPayload,
  headers: new Headers(),
  model: { id: 'm' } as ProviderModel,
});

describe('stripUnsupportedFields', () => {
  test('removes unsupported sampling / structured-output knobs', async () => {
    const ctx = mkCtx({
      temperature: 0.7,
      top_p: 0.9,
      max_tokens: 100,
      response_format: { type: 'json_object' },
      seed: 42,
      n: 2,
      frequency_penalty: 1,
      presence_penalty: 1,
      stream_options: { include_usage: true },
    });
    await stripUnsupportedFields(ctx, {}, async () => 'ok');
    const p = ctx.payload as unknown as Record<string, unknown>;
    expect(p['temperature']).toBeUndefined();
    expect(p['top_p']).toBeUndefined();
    expect(p['max_tokens']).toBeUndefined();
    expect(p['response_format']).toBeUndefined();
    expect(p['seed']).toBeUndefined();
    expect(p['n']).toBeUndefined();
    expect(p['stream_options']).toBeUndefined();
  });

  test('keeps messages, tools, model, stream, tool_choice', async () => {
    const ctx = mkCtx({
      stream: true,
      tools: [{ type: 'function', function: { name: 'search' } }],
      tool_choice: 'auto',
    });
    await stripUnsupportedFields(ctx, {}, async () => 'ok');
    const p = ctx.payload as unknown as Record<string, unknown>;
    expect(p['model']).toBe('m');
    expect(p['stream']).toBe(true);
    expect(Array.isArray(p['tools'])).toBe(true);
    expect(p['tool_choice']).toBe('auto');
    expect(Array.isArray(p['messages'])).toBe(true);
  });

  test('runs the inner chain and returns its result', async () => {
    const ctx = mkCtx({});
    const result = await stripUnsupportedFields(ctx, {}, async () => 'done');
    expect(result).toBe('done');
  });
});
