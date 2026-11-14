// The only thermometer for "exact recording is affordable". Nothing else in the system
// guards it: a stage rewritten to rebuild unconditionally drops this number to near zero
// while every other test still passes.

import { describe, expect, it } from 'vitest';

import { defineStage, move, transform } from '../src/index.ts';
import type { Handed } from '../src/index.ts';

interface Message { readonly role: string; readonly content: string }
type Payload = { readonly messages: readonly Message[] };
type Facts = { readonly 'request.chat.openaiChatCompletions': Payload };

const conversation = (turns: number): Payload => move({
  messages: [
    { role: 'system', content: 'You are a pirate.' },
    ...Array.from({ length: turns }, (_, i) => ({ role: i % 2 === 0 ? 'user' : 'assistant', content: `turn ${i}` })),
  ],
});

const nodes = (value: unknown): number =>
  typeof value !== 'object' || value === null ? 0 : 1 + Object.values(value).reduce((n, child) => n + nodes(child), 0);

const sharedWith = (before: unknown, after: unknown): number => {
  if (typeof after !== 'object' || after === null) return 0;
  if (before === after) return nodes(after);
  if (typeof before !== 'object' || before === null) return 0;
  return Object.entries(after).reduce(
    (n, [key, value]) => n + sharedWith((before as Record<string, unknown>)[key], value), 0,
  );
};

/** The convention: write conditionally, and what the stage did not change comes back by
 *  identity. Both forms behave identically and neither errors — the number is the only
 *  thing that watches the difference. */
const careful = defineStage<Facts, Facts, object, object>({
  name: 'careful',
  through: {
    request: { needs: ['request.chat.openaiChatCompletions'], consumes: [], provides: ['request.chat.openaiChatCompletions'] },
    response: { needs: [], consumes: [], provides: [] },
  },
  execute: transform(() => ({
    request: (facts): Handed<Facts> => {
      const payload = facts['request.chat.openaiChatCompletions'];
      return {
        ...facts,
        'request.chat.openaiChatCompletions': move({
          ...payload,
          messages: payload.messages.map(m => (m.role === 'system' ? { ...m, role: 'developer' } : m)),
        }),
      };
    },
  })),
});

const careless = (payload: Payload): Payload => move({
  ...payload,
  messages: payload.messages.map(m => ({ ...m, role: m.role === 'system' ? 'developer' : m.role })),
});

describe('structural sharing', () => {
  it('costs three objects on a 49-message conversation with one message rewritten', () => {
    const before = conversation(48);
    const rewritten = move({
      ...before,
      messages: before.messages.map(m => (m.role === 'system' ? { ...m, role: 'developer' } : m)),
    });
    expect(nodes(rewritten)).toBe(51);
    expect(sharedWith(before, rewritten)).toBe(48);
  });

  it('falls to nothing when a stage rebuilds unconditionally', () => {
    const before = conversation(48);
    expect(sharedWith(before, careless(before))).toBe(0);
  });

  it('holds its ratio as the conversation grows, because the cost is what changed', () => {
    for (const turns of [8, 48, 200]) {
      const before = conversation(turns);
      const rewritten = move({
        ...before,
        messages: before.messages.map(m => (m.role === 'system' ? { ...m, role: 'developer' } : m)),
      });
      // Whatever the length: the payload, the array, and the one message that changed.
      expect(nodes(rewritten) - sharedWith(before, rewritten)).toBe(3);
    }
  });

  it('is what a real stage produces, not just what a hand-written map produces', () => {
    const before = conversation(48);
    let handed: Facts | undefined;
    const erased = careful as unknown as {
      execute: (facts: Facts, next: (h: Facts) => Promise<object>, use: object) => Promise<object>;
    };
    return erased.execute(
      { 'request.chat.openaiChatCompletions': before },
      async h => { handed = h; return {}; },
      { log: { debug: () => {}, info: () => {}, warn: () => {}, error: () => {} } },
    ).then(() => {
      const after = handed!['request.chat.openaiChatCompletions'];
      expect(nodes(after) - sharedWith(before, after)).toBe(3);
    });
  });
});
