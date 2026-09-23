import { expect, test } from 'vitest';

import { ProviderModelsUnavailableError } from '../src/models-fetch.ts';

test('model-list failure parses JSON for display without changing the captured upstream response', () => {
  const body = '{"error":{"message":"token expired"}}';
  const failure = new ProviderModelsUnavailableError({
    status: 401,
    headers: new Headers({ 'content-type': 'application/json', 'retry-after': '5' }),
    body,
  });

  expect(failure.displayResponse).toEqual({
    status: 401,
    headers: [['content-type', 'application/json'], ['retry-after', '5']],
    body: JSON.stringify({ error: { message: 'token expired' } }, null, 2),
  });
  expect(failure.httpResponse?.body).toBe(body);
});

test('model-list failure shortens a long body only in its display projection', () => {
  const body = 'x'.repeat(20_000);
  const failure = new ProviderModelsUnavailableError({ status: 503, headers: new Headers(), body });

  expect(failure.displayResponse?.body).toBe(`${body.slice(0, 12_288)}…`);
  expect(failure.httpResponse?.body).toBe(body);
});
