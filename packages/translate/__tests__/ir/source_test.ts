import { test } from 'vitest';

import { readIRInput, type IRInputSource } from '../../src/ir/input/source.ts';
import type { IRInputTurn } from '../../src/ir/input/types.ts';
import { assertEquals } from '@floway-dev/test-utils';

// A reader that turns each source string into a client turn and buffers the
// last one until it learns whether the next source turn pairs with it.
const buffering = (turns: readonly string[], prompt?: IRInputTurn): IRInputSource<string> & { held: () => string | undefined } => {
  let held: IRInputTurn | undefined;
  return {
    prompt,
    conversation: turns,
    turnToIR: raw => {
      if (held === undefined) {
        held = { kind: 'client', items: [{ type: 'message', content: [{ type: 'text', text: raw }] }] };
        return [];
      }
      const merged: IRInputTurn = { kind: 'client', items: [...held.items, { type: 'message', content: [{ type: 'text', text: raw }] }] };
      held = undefined;
      return [{ kind: 'assistant', items: [{ type: 'message', content: [{ type: 'text', text: 'reply' }] }] }, merged];
    },
    // A resolved turn yields no IR of its own, but whatever the reader held back
    // sat before it in the source.
    observeResolvedTurn: () => {
      if (held === undefined) return [];
      const released: IRInputTurn[] = [held];
      held = undefined;
      return released;
    },
    flush: () => {
      if (held === undefined) return [];
      const released: IRInputTurn[] = [held];
      held = undefined;
      return released;
    },
    held: () => held as string | undefined,
  };
};

test('readIRInput releases what the reader held back when the conversation ends', async () => {
  const source = buffering(['only']);
  const pieces = await readIRInput(source, async () => undefined);
  assertEquals(pieces.length, 1);
  assertEquals(pieces[0].kind, 'client');
  assertEquals(source.held(), undefined);
});

test('readIRInput opens with the request prompt before any source turn', async () => {
  const prompt: IRInputTurn = { kind: 'client', items: [{ type: 'prompt', role: 'system', content: [{ type: 'text', text: 'be terse' }] }] };
  const pieces = await readIRInput(buffering([], prompt), async () => undefined);
  assertEquals(pieces, [prompt]);
});

test('readIRInput states what the reader releases ahead of a resolved turn', async () => {
  const source = buffering(['first', 'second']);
  const pieces = await readIRInput(source, async turn => (turn === 'second'
    ? { resolved: 'native', calls: [{ callId: 'call_1', name: 'lookup' }] }
    : undefined));
  // The reader held 'first' back; resolving 'second' makes the reader release it
  // before the native turn rather than after, because that is where it sat.
  assertEquals(pieces.map(piece => piece.kind), ['client', 'resolved']);
  assertEquals(source.held(), undefined);
});
