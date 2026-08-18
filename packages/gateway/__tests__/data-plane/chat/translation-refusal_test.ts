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
//
// Both of Gemini generateContent's actions cross a protocol boundary and both are covered: generation reaches
// its target through a handoff, and `:countTokens` through the pair that asks the question in
// Anthropic Messages. The replaced surface answered a refusal the same way on either, because what the
// caller reads is the same protocol whichever action it asked for.

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

// A `functionResponse` part in model content: a shape Gemini generateContent defines and neither target protocol
// has anywhere to put, so the translator refuses it rather than dropping it.
const untranslatableGeminiGenerateContentBody = {
  contents: [
    { role: 'model', parts: [{ functionResponse: { name: 'f', response: { ok: true } } }] },
    { role: 'user', parts: [{ text: 'hi' }] },
  ],
};

/** What a Gemini generateContent client reads a refusal out of. `error.status` is the field it keys on, and it
 *  is not a field the gateway's internal-error envelope has — nor is `stack` a field a
 *  caller-input refusal has any business carrying. */
const assertGoogleRpcRefusal = async (response: Response): Promise<void> => {
  assertEquals(response.status, 400);
  const body = await response.json() as { error: { code: number; status: string; message: string } };
  assertEquals(body.error.code, 400);
  assertEquals(body.error.status, 'INVALID_ARGUMENT');
  assertEquals(body.error.message.includes('not supported in model content'), true);
  assertEquals('stack' in body.error, false);
};

test('a body the target protocol cannot carry is refused in the client own protocol', async () => {
  const { apiKey } = await setupAppTest();

  await withMockedFetch(
    upstream([{ id: 'gpt-translate', supported_endpoints: ['/chat/completions'] }]),
    async () => {
      await assertGoogleRpcRefusal(await requestApp('/v1beta/models/gpt-translate:generateContent', {
        method: 'POST',
        headers: { 'content-type': 'application/json', 'x-api-key': apiKey.key },
        body: JSON.stringify(untranslatableGeminiGenerateContentBody),
      }));
    },
  );
});

// Counting crosses the same boundary. It has no handoff — what crosses is one measurement, not
// frames — so the refusal it can hit is its own to answer, and answering it anywhere else means
// a caller asking what a turn would cost is told the gateway broke.
test('a body the counting wire cannot carry is refused in the client own protocol', async () => {
  const { apiKey } = await setupAppTest();

  await withMockedFetch(
    // Counting is reachable only over an upstream's own Anthropic Messages endpoint, so this is the one
    // candidate shape that gets as far as the translation.
    upstream([{ id: 'claude-count', supported_endpoints: ['/messages'] }]),
    async () => {
      await assertGoogleRpcRefusal(await requestApp('/v1beta/models/claude-count:countTokens', {
        method: 'POST',
        headers: { 'content-type': 'application/json', 'x-api-key': apiKey.key },
        body: JSON.stringify(untranslatableGeminiGenerateContentBody),
      }));
    },
  );
});
