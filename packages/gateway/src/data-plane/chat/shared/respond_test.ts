import { test } from 'vitest';

import { SourceStreamState } from './respond.ts';
import { assertEquals } from '@floway-dev/test-utils';

// ── SourceStreamState classification ──

test('SourceStreamState.failedAfter classifies error completion as failed', () => {
  const state = new SourceStreamState();
  state.completed = true;

  assertEquals(state.failedAfter('error'), true);
});

test('SourceStreamState.failedAfter classifies state.failed as failed regardless of completion', () => {
  const state = new SourceStreamState();
  state.failed = true;
  state.completed = true;

  assertEquals(state.failedAfter('eof'), true);
});

test('SourceStreamState.failedAfter classifies cancel-before-complete as failed', () => {
  const state = new SourceStreamState();
  state.completed = false;

  assertEquals(state.failedAfter('cancel'), true);
});

test('SourceStreamState.failedAfter treats cancel-after-complete as graceful', () => {
  const state = new SourceStreamState();
  state.completed = true;

  assertEquals(state.failedAfter('cancel'), false);
});

test('SourceStreamState.failedAfter treats clean EOF as graceful', () => {
  const state = new SourceStreamState();
  state.completed = true;

  assertEquals(state.failedAfter('eof'), false);
});

// ── SourceStreamState.rememberUsage ──

test('SourceStreamState.rememberUsage keeps real usage and ignores zero figures', () => {
  const state = new SourceStreamState();
  state.rememberUsage({ input: 50, output: 10 });
  assertEquals(state.usage, { input: 50, output: 10 });

  state.rememberUsage({});
  assertEquals(state.usage, { input: 50, output: 10 });

  state.rememberUsage(null);
  assertEquals(state.usage, { input: 50, output: 10 });

  state.rememberUsage({ input: 0, output: 0 });
  assertEquals(state.usage, { input: 50, output: 10 });
});
