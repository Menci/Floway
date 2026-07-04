import { describe, expect, test } from 'vitest';

import { injectDefaultInstructions } from './inject-default-instructions.ts';
import type { ChatCompletionsBoundaryCtx } from './types.ts';
import type { ChatCompletionsPayload } from '@floway-dev/protocols/chat-completions';
import type { ProviderModel } from '@floway-dev/provider';

const mkCtx = (messages: ChatCompletionsPayload['messages']): ChatCompletionsBoundaryCtx => ({
  payload: { model: 'm', messages },
  headers: new Headers(),
  model: { id: 'm' } as ProviderModel,
});

describe('injectDefaultInstructions', () => {
  test('prepends a default system message when none exists', async () => {
    const ctx = mkCtx([{ role: 'user', content: 'hi' }]);
    await injectDefaultInstructions(ctx, {}, async () => 'ok');
    expect(ctx.payload.messages[0]!.role).toBe('system');
    expect(ctx.payload.messages[1]!.content).toBe('hi');
  });

  test('leaves messages unchanged when a system message exists', async () => {
    const ctx = mkCtx([{ role: 'system', content: 'sys' }, { role: 'user', content: 'hi' }]);
    await injectDefaultInstructions(ctx, {}, async () => 'ok');
    expect(ctx.payload.messages).toHaveLength(2);
    expect(ctx.payload.messages[0]!.content).toBe('sys');
  });

  test('treats developer as a system message', async () => {
    const ctx = mkCtx([{ role: 'developer', content: 'dev' }, { role: 'user', content: 'hi' }]);
    await injectDefaultInstructions(ctx, {}, async () => 'ok');
    expect(ctx.payload.messages).toHaveLength(2);
  });

  test('runs the inner chain and returns its result', async () => {
    const ctx = mkCtx([{ role: 'user', content: 'hi' }]);
    const result = await injectDefaultInstructions(ctx, {}, async () => 'done');
    expect(result).toBe('done');
  });
});
