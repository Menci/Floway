import { describe, expect, it } from 'vitest';

import { copilotModels, requestApp, setupAppTest } from '../../test-helpers.ts';
import { jsonResponse, withMockedFetch } from '@floway-dev/test-utils';

const fetchForModels = (request: Request): Response => {
  const url = new URL(request.url);
  if (url.hostname === 'update.code.visualstudio.com') return jsonResponse(['1.110.1']);
  if (url.pathname === '/copilot_internal/v2/token') {
    return jsonResponse({
      token: 'test-copilot-token',
      expires_at: 4102444800,
      refresh_in: 3600,
      endpoints: { api: 'https://api.individual.githubcopilot.com' },
    });
  }
  if (url.hostname === 'api.individual.githubcopilot.com' && url.pathname === '/models') {
    return jsonResponse(copilotModels([{
      id: 'gpt-5.4',
      display_name: 'GPT-5.4',
      supported_endpoints: ['/responses'],
      maxContextWindowTokens: 272_000,
    }]));
  }
  if (url.hostname === 'raw.githubusercontent.com') return jsonResponse({ models: [] });
  throw new Error(`Unhandled fetch ${request.url}`);
};

const requestModels = async (path: string, apiKey: string, userAgent: string): Promise<Response> =>
  await requestApp(path, { headers: { 'x-api-key': apiKey, 'user-agent': userAgent } });

describe('model catalog dispatcher', () => {
  it('serves Codex catalog shape from bare /models for both official Codex products', async () => {
    const { apiKey } = await setupAppTest();

    await withMockedFetch(fetchForModels, async () => {
      for (const userAgent of [
        'codex_cli_rs/0.999.1 (Mac OS 15.5; arm64)',
        'codex_exec/0.999.2 (linux; x86_64)',
      ]) {
        const response = await requestModels('/models', apiKey.key, userAgent);
        expect(response.status).toBe(200);
        const body = await response.json() as { models?: Array<{ slug: string }>; data?: unknown };
        expect(body.models?.map(model => model.slug)).toEqual(['gpt-5.4']);
        expect(body.data).toBeUndefined();
      }
    });
  });

  it('keeps Claude Code and generic projections on bare /models', async () => {
    const { apiKey } = await setupAppTest();

    await withMockedFetch(fetchForModels, async () => {
      const claudeResponse = await requestModels('/models', apiKey.key, 'claude-code/2.1.211');
      expect(claudeResponse.status).toBe(200);
      const claudeBody = await claudeResponse.json() as { object?: unknown; data: Array<{ id: string }> };
      expect(claudeBody.object).toBeUndefined();
      expect(claudeBody.data.map(model => model.id)).toEqual(['claude-code!gpt-5.4']);

      const genericResponse = await requestModels('/models', apiKey.key, 'curl/8.7.1');
      expect(genericResponse.status).toBe(200);
      const genericBody = await genericResponse.json() as { object: string; models?: unknown; data: Array<{ id: string }> };
      expect(genericBody.object).toBe('list');
      expect(genericBody.models).toBeUndefined();
      expect(genericBody.data.map(model => model.id)).toEqual(['gpt-5.4']);
    });
  });

  it('does not dispatch /v1/models by Codex User-Agent', async () => {
    const { apiKey } = await setupAppTest();

    await withMockedFetch(fetchForModels, async () => {
      const response = await requestModels('/v1/models', apiKey.key, 'codex_cli_rs/0.999.3 (Mac OS 15.5; arm64)');
      expect(response.status).toBe(200);
      const body = await response.json() as { object: string; models?: unknown; data: Array<{ id: string }> };
      expect(body.object).toBe('list');
      expect(body.models).toBeUndefined();
      expect(body.data.map(model => model.id)).toEqual(['gpt-5.4']);
    });
  });
});
