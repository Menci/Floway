import { test } from 'vitest';

import { SourceStreamState, plainResultFromResponse } from '../../../../src/data-plane/chat/shared/respond.ts';
import { bufferedResultToResponse, readUpstreamApiError } from '@floway-dev/provider';
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

test.each([204, 205, 304])('buffered responses preserve the absent body for HTTP %i', async status => {
  const upstream = new Response(null, { status, headers: { 'request-id': 'req-empty' } });
  for (const result of [await plainResultFromResponse(upstream), await readUpstreamApiError(upstream)]) {
    assertEquals(result.body, null);
    const response = bufferedResultToResponse(result);
    assertEquals(response.status, status);
    assertEquals(response.headers.get('request-id'), 'req-empty');
    assertEquals(response.body, null);
  }
});

test('buffered responses preserve an explicitly empty body', async () => {
  const result = await plainResultFromResponse(new Response(new Uint8Array()));
  assertEquals(result.body, new Uint8Array());
  const response = bufferedResultToResponse(result);
  assertEquals(response.body === null, false);
  assertEquals((await response.arrayBuffer()).byteLength, 0);
});
