import { expect, test } from 'vitest';

import { decisionIngress } from '../../../../src/data-plane/non-chat/decision/index.ts';
import { customCandidate, post, setupNonChat } from '../fixtures.ts';
import { getHeader } from '@floway-dev/http';
import { run } from '@floway-dev/pipeline';

const request = () => ({
  ...post({
    model: 'public-model',
    input: 'The API returns 500 on every call.',
    questions: [{
      type: 'choice',
      name: 'team',
      instructions: 'Which team?',
      choices: [{ value: 'billing', description: 'Charges' }, { value: 'engineering', description: 'Bugs' }],
    }],
  }, '/v1/decisions'),
  decisionDialect: 'openai-decisions' as const,
});

test('decision preserves upstream status and headers while encoding a non-JSON error', async () => {
  const candidate = customCandidate('decisions', {
    kind: 'decision',
    endpoints: { decision: {} },
    decisionTarget: { protocol: 'openai-decisions' },
  });
  const fixture = await setupNonChat([candidate], () => async () => new Response('upstream rate limit', {
    status: 429,
    statusText: 'Too Many Requests',
    headers: { 'retry-after': '5', 'x-request-id': 'upstream-429', 'content-type': 'text/plain' },
  }));
  const host = fixture.host();
  const running = run(decisionIngress, request(), host.options);

  const answer = await running.result;
  expect(answer.http?.status).toBe(429);
  expect(answer.http?.statusText).toBe('Too Many Requests');
  expect(getHeader(answer.http?.headers ?? [], 'retry-after')).toBe('5');
  expect(getHeader(answer.http?.headers ?? [], 'x-request-id')).toBe('upstream-429');
  expect(getHeader(answer.http?.headers ?? [], 'content-type')).toBe('application/json');
  if (!(answer.http?.body instanceof Uint8Array) || answer.usage === undefined) throw new Error('Expected encoded decision error and selected usage observation');
  expect(JSON.parse(new TextDecoder().decode(answer.http.body))).toEqual({
    error: { type: 'invalid_request_error', message: 'upstream rate limit' },
  });
  await expect(running.read(answer.usage)).resolves.toEqual({ kind: 'upstream-error' });
  host.controller.abort();
  running.discard(answer);
  await host.settle();
  expect(host.errors).toEqual([]);
  expect(fixture.recordUsage).not.toHaveBeenCalled();
  expect(fixture.recordPerformance).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({ operation: 'decision', failed: true }));
});

test('decision preserves reported input usage when a cross-dialect result is damaged', async () => {
  const candidate = customCandidate('damaged', {
    kind: 'decision',
    endpoints: { decision: {} },
    decisionTarget: { protocol: 'typesafe-systemone' },
  });
  const fixture = await setupNonChat([candidate], () => async () => Response.json({
    model: 'wire-model',
    answers: 'invalid',
    usage: { input_tokens: 7 },
  }, { headers: { 'x-request-id': 'damage' } }));
  const host = fixture.host();
  const running = run(decisionIngress, request(), host.options);
  const answer = await running.result;
  expect(answer.http?.status).toBe(502);
  expect(getHeader(answer.http?.headers ?? [], 'x-request-id')).toBe('damage');
  if (!(answer.http?.body instanceof Uint8Array) || answer.usage === undefined) throw new Error('Expected encoded decision error and observed usage');
  const body: unknown = JSON.parse(new TextDecoder().decode(answer.http.body));
  expect(body).toMatchObject({ error: { message: expect.stringContaining('answers') } });
  await expect(running.read(answer.usage)).resolves.toMatchObject({
    kind: 'observed',
    usage: [{ reported: true, quantities: { input_tokens: '7' } }],
  });
  host.controller.abort();
  running.discard(answer);
  await host.settle();
  expect(host.errors).toEqual([]);
  expect(fixture.recordUsage).toHaveBeenCalledExactlyOnceWith(
    expect.objectContaining({ upstream: 'damaged' }),
    expect.objectContaining({ quantities: { input_tokens: '7' } }),
  );
  expect(fixture.recordPerformance).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({ operation: 'decision', failed: true }));
});
