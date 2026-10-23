import { test } from 'vitest';

import { plainResultFromResponse, plainResultToResponse, SourceStreamState } from '../../../../src/data-plane/chat/shared/respond.ts';
import { assertEquals } from '@floway-dev/test-utils';

test('measurement response conversion preserves retry and correlation headers without forwarding cookies or body framing', async () => {
  const upstream = new Response('rate limited', {
    status: 429,
    headers: {
      'retry-after': '17',
      'request-id': 'req-measurement',
      'set-cookie': 'session=private',
      'connection': 'close',
      'content-length': '999',
      'content-encoding': 'gzip',
    },
  });
  const response = plainResultToResponse(await plainResultFromResponse(upstream, 'upstream'));
  assertEquals(response.status, 429);
  assertEquals(response.headers.get('retry-after'), '17');
  assertEquals(response.headers.get('request-id'), 'req-measurement');
  for (const name of ['set-cookie', 'connection', 'content-length', 'content-encoding']) assertEquals(response.headers.get(name), null);
  assertEquals(await response.text(), 'rate limited');
});

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
