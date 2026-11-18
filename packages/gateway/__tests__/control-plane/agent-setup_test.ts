// Gateway-side integration tests for Agent Setup: the wiring the package cannot
// own — public scripts mounted ahead of the logger / CORS / auth middleware,
// control routes behind auth, and the opaque-error boundary. The lease
// lifecycle and multi-page semantics are covered in the package's own tests.

import { expect, test, vi } from 'vitest';

import { getRepo } from '../../src/repo/index.ts';
import type { ApiKey } from '../../src/repo/types.ts';
import { saveUpstreamForTest } from '../repo/upstreams.ts';
import { buildCustomUpstreamRecord, copilotModels, requestApp, requestAppWithWarmModels, setupAppTest } from '../test-utils/app.ts';
import { assertEquals, jsonResponse, withMockedFetch } from '@floway-dev/test-utils';

const RAW_KEY = 'raw-key';

const testApiKey = (overrides: Partial<ApiKey> = {}): ApiKey => ({
  id: 'key_primary',
  userId: 2,
  name: 'Primary key',
  key: RAW_KEY,
  serverSecret: '00'.repeat(32),
  createdAt: '2026-03-15T00:00:00.000Z',
  upstreamIds: null,
  randomizeUpstreams: false,
  deletedAt: null,
  dumpRetentionSeconds: null,
  openaiResponsesRetentionSeconds: 0,
  ...overrides,
});

interface LeaseResponse {
  status: string;
  token: string;
  scripts: { claude: { sh: string; ps1: string }; codex: { sh: string; ps1: string }; pi: { sh: string; ps1: string }; omp: { sh: string; ps1: string } };
}

const createLease = async (apiKey: ApiKey): Promise<LeaseResponse> => {
  const response = await requestApp('/api/setup', {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-api-key': apiKey.key },
    body: JSON.stringify({ apiKeyId: apiKey.id }),
  });
  assertEquals(response.status, 200);
  return (await response.json()) as LeaseResponse;
};

test('the public GET serves the rendered script with hardened headers and no CORS, requiring no auth', async () => {
  const { apiKey } = await setupAppTest({ apiKey: testApiKey() });
  const lease = await createLease(apiKey);

  const response = await requestApp(lease.scripts.claude.sh, { method: 'GET' });
  assertEquals(response.status, 200);
  assertEquals(response.headers.get('access-control-allow-origin'), null);
  const text = await response.text();
  expect(text).toContain("SETUP_API_KEY='raw-key'");
  expect(text).toContain("SETUP_API_KEY_NAME='Primary key'");

  const piResponse = await requestApp(lease.scripts.pi.sh, { method: 'GET' });
  assertEquals(piResponse.status, 200);
  assertEquals(piResponse.headers.get('access-control-allow-origin'), null);
  const piText = await piResponse.text();
  expect(piText).toContain("SETUP_API_KEY='raw-key'");
  expect(piText).toContain(`SETUP_EXTENSION_PATH='/api/setup/${lease.token}/pi.js'`);
  expect(piText).toContain("main 'Pi'");
  const ompResponse = await requestApp(lease.scripts.omp.sh, { method: 'GET' });
  assertEquals(ompResponse.status, 200);
  const ompText = await ompResponse.text();
  expect(ompText).toContain("SETUP_API_KEY='raw-key'");
  expect(ompText).toContain("main 'oh-my-pi'");
});

test('Pi discovery uses authenticated model visibility and preserves upstream filters', async () => {
  const { repo } = await setupAppTest({ apiKey: testApiKey({ upstreamIds: ['up_custom_models'] }) });
  await saveUpstreamForTest(repo.upstreams, buildCustomUpstreamRecord({ id: 'up_custom_models', sortOrder: 100 }));

  await withMockedFetch(
    request => {
      const url = new URL(request.url);
      if (url.hostname === 'update.code.visualstudio.com') return jsonResponse(['1.110.1']);
      if (url.pathname === '/copilot_internal/v2/token') {
        return jsonResponse({ token: 'copilot-access-token', expires_at: 4102444800, refresh_in: 3600, endpoints: { api: 'https://api.individual.githubcopilot.com' } });
      }
      if (url.hostname === 'api.individual.githubcopilot.com' && url.pathname === '/models') {
        return jsonResponse(copilotModels([{ id: 'claude-sonnet-4', display_name: 'Claude Sonnet 4', supported_endpoints: ['/v1/messages'] }]));
      }
      if (url.hostname === 'custom.example.com' && url.pathname === '/v1/models') {
        return jsonResponse({ object: 'list', data: [{ id: 'custom-model', supported_endpoints: ['/chat/completions'] }] });
      }
      throw new Error(`Unhandled fetch ${request.url}`);
    },
    async () => {
      const response = await requestAppWithWarmModels('/v1/models', { headers: { Authorization: `Bearer ${RAW_KEY}`, 'User-Agent': 'pi/1.1.0 (linux; node/v22.19.0; x64)' } });
      assertEquals(response.status, 200);
      assertEquals(response.headers.get('content-type'), 'application/json');
      const text = await response.text();
      expect(text).not.toContain(RAW_KEY);
      const body = JSON.parse(text) as { models: Array<{ id: string }> };
      assertEquals(body.models.map(model => model.id), ['custom-model']);
      const publicResponse = await requestAppWithWarmModels('http://internal:8788/v1/models?endpoint=https%3A%2F%2Fpublic.example%2Fproxy', {
        headers: { Authorization: `Bearer ${RAW_KEY}`, 'User-Agent': 'pi/1.1.0 (linux; node/v22.19.0; x64)' },
      });
      assertEquals(publicResponse.status, 200);
      const publicBody = await publicResponse.json() as { models: { baseUrl: string }[] };
      assertEquals(publicBody.models.map(model => model.baseUrl), ['https://public.example/proxy/v1']);
      for (const endpoint of ['file:///etc/config', 'https://user:password@public.example']) {
        const invalid = await requestApp(`http://internal:8788/v1/models?endpoint=${encodeURIComponent(endpoint)}`, {
          headers: { Authorization: `Bearer ${RAW_KEY}`, 'User-Agent': 'pi/1.1.0 (linux; node/v22.19.0; x64)' },
        });
        assertEquals(invalid.status, 400);
        assertEquals(await invalid.json(), { error: { message: endpoint.startsWith('file:') ? 'The endpoint must use HTTP or HTTPS' : 'The endpoint must contain only an origin and path', type: 'invalid_request_error' } });
      }

    },
  );
});

test('the public script route is mounted ahead of the logger, so the lease token never reaches a log line', async () => {
  const { apiKey } = await setupAppTest({ apiKey: testApiKey() });
  const lease = await createLease(apiKey);

  const logged: string[] = [];
  const logSpy = vi.spyOn(console, 'log').mockImplementation((...args) => { logged.push(args.map(String).join(' ')); });
  try {
    await requestApp(lease.scripts.claude.sh, { method: 'GET' });
  } finally {
    logSpy.mockRestore();
  }
  const joined = logged.join('\n');
  expect(joined).not.toContain(lease.token);
  // The route returns before the logger middleware runs, so there is no
  // completion line for it at all.
  expect(joined).not.toContain('/api/setup/');
});

test('a public-serve failure is sealed to an opaque 500 that leaks neither token nor secret', async () => {
  const { apiKey } = await setupAppTest({ apiKey: testApiKey() });
  const lease = await createLease(apiKey);
  const repo = getRepo();

  const injectedSecret = 'INJECTED-SECRET-sk-abcdef0123456789';
  repo.agentSetup.findByToken = () => { throw new Error(`forced failure leaking ${lease.token} and ${injectedSecret}`); };

  const logged: string[] = [];
  const errorSpy = vi.spyOn(console, 'error').mockImplementation((...args) => { logged.push(args.map(String).join(' ')); });
  try {
    const response = await requestApp(lease.scripts.claude.sh, { method: 'GET' });
    assertEquals(response.status, 500);
    const raw = await response.text();
    expect(JSON.parse(raw)).toEqual({ error: { type: 'internal_error' } });
    expect(raw).not.toContain(lease.token);
    expect(raw).not.toContain(injectedSecret);
  } finally {
    errorSpy.mockRestore();
  }
  const joined = logged.join('\n');
  expect(joined).not.toContain(lease.token);
  expect(joined).not.toContain(injectedSecret);
  expect(joined).not.toContain('forced failure');
});
