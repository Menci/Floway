// A body the target protocol cannot represent is the client's fault.
//
// A translated wire runs the client's body through a translator, and a translator refuses input
// it would otherwise have to coerce or silently drop. The replaced surface rendered that refusal
// as a 400 in the client's own protocol; a run that let it escape as a throw would answer 500 with
// a stack trace, telling the caller that the gateway broke on a request that was simply not
// serveable over that wire.
//
// It is answered rather than thrown for a second reason the replaced surface had no way to
// express: the verdict belongs to one candidate. The next candidate may be reachable on a wire
// whose protocol *can* carry the body, and failover re-runs the suffix to find out.

import { test } from 'vitest';

import { copilotModels, requestApp, setupAppTest } from '../../test-utils/app.ts';
import { assertEquals, jsonResponse, withMockedFetch } from '@floway-dev/test-utils';

const upstream = (models: Parameters<typeof copilotModels>[0]) => async (request: Request): Promise<Response> => {
  const url = new URL(request.url);
  if (url.hostname === 'update.code.visualstudio.com') return jsonResponse(['1.110.1']);
  if (url.pathname === '/copilot_internal/v2/token') {
    return jsonResponse({ token: 'copilot-access-token', expires_at: 4102444800, refresh_in: 3600, endpoints: { api: 'https://api.individual.githubcopilot.com' } });
  }
  if (url.pathname === '/models') return jsonResponse(copilotModels(models));
  throw new Error(`Unhandled fetch ${request.url}`);
};

// A `functionResponse` part in model content: a shape Gemini defines and Chat Completions has
// nowhere to put, so the translator refuses it rather than dropping it.
const untranslatableGeminiBody = {
  contents: [
    { role: 'model', parts: [{ functionResponse: { name: 'f', response: { ok: true } } }] },
    { role: 'user', parts: [{ text: 'hi' }] },
  ],
};

test('a body the target protocol cannot carry is refused in the client own protocol', async () => {
  const { apiKey } = await setupAppTest();

  await withMockedFetch(
    upstream([{ id: 'gpt-translate', supported_endpoints: ['/chat/completions'] }]),
    async () => {
      const response = await requestApp('/v1beta/models/gpt-translate:generateContent', {
        method: 'POST',
        headers: { 'content-type': 'application/json', 'x-api-key': apiKey.key },
        body: JSON.stringify(untranslatableGeminiBody),
      });

      // Google-RPC, not the gateway's internal-error envelope: `error.status` is the field a
      // Gemini client reads, and a 500 would name the gateway as the party at fault.
      assertEquals(response.status, 400);
      const body = await response.json() as { error: { code: number; status: string; message: string } };
      assertEquals(body.error.code, 400);
      assertEquals(body.error.status, 'INVALID_ARGUMENT');
      assertEquals(body.error.message.includes('not supported in model content'), true);
      // The stack trace an internal failure carries has no business in a caller-input refusal.
      assertEquals('stack' in body.error, false);
    },
  );
});
