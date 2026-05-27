import { test } from 'vitest';

import { clearCopilotTokenCache, copilotFetch } from './copilot.ts';
import { initRepo } from '../repo/index.ts';
import { InMemoryRepo } from '../repo/memory.ts';
import { assertEquals } from '../test-assert.ts';
import { jsonResponse, withMockedFetch } from '../test-helpers.ts';

// We tag the test repo so getRepo() does not error during clearCopilotTokenCache;
// the cache KV writes go through this in-memory repo.

const installRepoAndClearCache = async () => {
  initRepo(new InMemoryRepo());
  await clearCopilotTokenCache();
};

const mockTokenAndCapture = async (
  extraHeaders: Record<string, string> | undefined,
  assert: (headers: Headers) => void,
): Promise<void> => {
  await installRepoAndClearCache();
  let captured: Headers | null = null;

  await withMockedFetch(
    async request => {
      const url = new URL(request.url);
      if (url.pathname === '/copilot_internal/v2/token') {
        return jsonResponse({ token: 'tok-test', expires_at: Math.floor(Date.now() / 1000) + 3600, refresh_in: 1800 });
      }
      captured = new Headers(request.headers);
      return new Response('{}', { status: 200, headers: { 'content-type': 'application/json' } });
    },
    async () => {
      await copilotFetch(
        '/v1/messages',
        { method: 'POST', body: '{}' },
        'ghu_test',
        'individual',
        extraHeaders ? { headers: extraHeaders } : undefined,
      );
    },
  );

  if (!captured) throw new Error('upstream call never observed');
  assert(captured);
};

test('copilotFetch overlays interceptor headers on the pinned base set', async () => {
  await mockTokenAndCapture({ 'x-initiator': 'agent', 'copilot-vision-request': 'true' }, headers => {
    assertEquals(headers.get('x-initiator'), 'agent');
    assertEquals(headers.get('copilot-vision-request'), 'true');
    // Base headers we did not override stay pinned.
    assertEquals(headers.get('copilot-integration-id'), 'vscode-chat');
    assertEquals(headers.get('openai-intent'), 'conversation-agent');
  });
});

test('copilotFetch deletes a base header when the interceptor passes an empty-string value', async () => {
  // Sentinel contract: empty string means "drop this base header". This is
  // the deletion convention later workaround interceptors rely on; future
  // commits will add concrete callers (e.g. clearing copilot-integration-id
  // on Claude Code SDK proxy traffic).
  await mockTokenAndCapture({ 'copilot-integration-id': '' }, headers => {
    assertEquals(headers.has('copilot-integration-id'), false);
  });
});
