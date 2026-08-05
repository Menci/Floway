import { expect, test, vi } from 'vitest';

import { requestApp, setupAppTest } from '../test-utils/app.ts';
import { assertEquals } from '@floway-dev/test-utils';

const escapeRegExp = (value: string): string => value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

test('request logs omit credential queries while retaining method, path, status, and timing', async () => {
  const { repo, apiKey } = await setupAppTest();
  const session = await repo.sessions.create(apiKey.userId);
  const requests = [
    {
      method: 'GET',
      path: '/api/dump/keys/missing/stream',
      url: `/api/dump/keys/missing/stream?session=${encodeURIComponent(session.id)}&source=regression`,
    },
    {
      method: 'POST',
      path: '/v1/request-log-regression',
      url: `/v1/request-log-regression?key=${encodeURIComponent(apiKey.key)}&source=regression`,
    },
  ] as const;

  const messages: string[] = [];
  const logSpy = vi.spyOn(console, 'log').mockImplementation((...args) => {
    messages.push(args.map(String).join(' '));
  });
  try {
    for (const request of requests) {
      const response = await requestApp(request.url, { method: request.method });
      assertEquals(response.status, 404);
    }
  } finally {
    logSpy.mockRestore();
  }

  expect(messages).toHaveLength(requests.length * 2);
  for (const request of requests) {
    expect(messages).toContain(`<-- ${request.method} ${request.path}`);
    expect(messages).toContainEqual(expect.stringMatching(
      new RegExp(`^--> ${request.method} ${escapeRegExp(request.path)} 404 \\d+(?:,\\d{3})*(?:ms|s)$`),
    ));
  }

  const output = messages.join('\n');
  expect(output).not.toContain(session.id);
  expect(output).not.toContain(apiKey.key);
  expect(output).not.toContain('?');
  expect(output).not.toContain('source=regression');
});
