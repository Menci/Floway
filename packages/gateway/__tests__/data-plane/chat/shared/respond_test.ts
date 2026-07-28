import { test } from 'vitest';

import { SourceStreamState } from '../../../../src/data-plane/chat/shared/respond.ts';
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
