import { test } from 'vitest';

import { copilotModels, requestAppWithWarmModels, setupAppTest } from '../../test-utils/app.ts';
import { jsonResponse, withMockedFetch, assertEquals } from '@floway-dev/test-utils';

// The listing shape follows the client identity, not the path, so a Gemini
// suite addresses the Gemini shape the same way a real SDK does.
const GEMINI_HEADERS = (apiKey: string) => ({ 'x-api-key': apiKey, 'user-agent': 'google-genai-sdk/1.0.0 gl-node/cross' });

test('/v1beta/models lists Copilot LLM models in Gemini model shape', async () => {
  const { apiKey } = await setupAppTest();

  await withMockedFetch(
    request => {
      const url = new URL(request.url);

      if (url.hostname === 'update.code.visualstudio.com') {
        return jsonResponse(['1.110.1']);
      }
      if (url.pathname === '/copilot_internal/v2/token') {
        return jsonResponse({
          token: 'copilot-access-token',
          expires_at: 4102444800,
          refresh_in: 3600,
          endpoints: { api: 'https://api.individual.githubcopilot.com' },
        });
      }
      if (url.pathname === '/models') {
        return jsonResponse({
          object: 'list',
          data: [
            {
              id: 'gpt-gemini-list',
              name: 'gpt-gemini-list',
              display_name: 'GPT Gemini List',
              version: '1',
              object: 'model',
              capabilities: {
                family: 'test',
                type: 'chat',
                limits: {
                  max_prompt_tokens: 12345,
                  max_output_tokens: 678,
                },
                supports: {},
              },
            },
            {
              id: 'embedding-only',
              name: 'embedding-only',
              version: '1',
              object: 'model',
              supported_endpoints: ['/embeddings'],
              capabilities: {
                family: 'test',
                type: 'embeddings',
                limits: {},
                supports: {},
              },
            },
          ],
        });
      }

      throw new Error(`Unhandled fetch ${request.url}`);
    },
    async () => {
      const response = await requestAppWithWarmModels('/v1beta/models', {
        headers: GEMINI_HEADERS(apiKey.key),
      });

      assertEquals(response.status, 200);
      const body = await response.json();
      assertEquals(body.models, [
        {
          name: 'models/gpt-gemini-list',
          baseModelId: 'gpt-gemini-list',
          displayName: 'GPT Gemini List',
          supportedGenerationMethods: ['generateContent', 'streamGenerateContent', 'countTokens'],
          inputTokenLimit: 12345,
          outputTokenLimit: 678,
          temperature: 1,
          topP: 0.95,
          topK: 40,
        },
      ]);
    },
  );
});

test('/v1beta/models/:modelId returns one Gemini model or Google RPC 404', async () => {
  const { apiKey } = await setupAppTest();

  await withMockedFetch(
    request => {
      const url = new URL(request.url);

      if (url.hostname === 'update.code.visualstudio.com') {
        return jsonResponse(['1.110.1']);
      }
      if (url.pathname === '/copilot_internal/v2/token') {
        return jsonResponse({
          token: 'copilot-access-token',
          expires_at: 4102444800,
          refresh_in: 3600,
          endpoints: { api: 'https://api.individual.githubcopilot.com' },
        });
      }
      if (url.pathname === '/models') {
        return jsonResponse(copilotModels([{ id: 'gpt-gemini-get', supported_endpoints: ['/v1/messages'] }]));
      }

      throw new Error(`Unhandled fetch ${request.url}`);
    },
    async () => {
      const found = await requestAppWithWarmModels('/v1beta/models/gpt-gemini-get', {
        headers: GEMINI_HEADERS(apiKey.key),
      });
      assertEquals(found.status, 200);
      const model = await found.json();
      assertEquals(model.name, 'models/gpt-gemini-get');
      assertEquals(model.supportedGenerationMethods, ['generateContent', 'streamGenerateContent', 'countTokens']);

      const missing = await requestAppWithWarmModels('/v1beta/models/missing-model', {
        headers: GEMINI_HEADERS(apiKey.key),
      });
      assertEquals(missing.status, 404);
      assertEquals(await missing.json(), {
        error: {
          code: 404,
          message: 'Model not found: missing-model',
          status: 'NOT_FOUND',
        },
      });
    },
  );
});

test('Gemini clients are recognized through x-goog-api-client and the legacy SDK labels', async () => {
  const { apiKey } = await setupAppTest();

  await withMockedFetch(
    request => {
      if (new URL(request.url).hostname === 'api.individual.githubcopilot.com') return jsonResponse(copilotModels([]));
      throw new Error(`Unhandled fetch ${request.url}`);
    },
    async () => {
      const identities: ReadonlyArray<Record<string, string>> = [
        { 'x-goog-api-client': 'google-genai-sdk/1.0.0 gl-python/3.13.0' },
        { 'user-agent': 'GeminiCLI/0.12.0/gemini-2.5-pro (darwin; arm64; shell)', 'x-goog-api-client': 'google-genai-sdk/1.3.0 gl-node/cross' },
        { 'user-agent': 'genai-py/0.8.5 gl-python/3.12.0' },
        { 'x-goog-api-client': 'genai-js/0.24.1' },
      ];
      for (const identity of identities) {
        const response = await requestAppWithWarmModels('/v1/models', { headers: { 'x-api-key': apiKey.key, ...identity } });
        assertEquals(response.status, 200);
        const body = await response.json() as { models?: unknown; data?: unknown };
        assertEquals(Array.isArray(body.models), true);
        assertEquals(body.data, undefined);
      }
    },
  );
});
