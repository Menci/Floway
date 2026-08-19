// `/v1/responses`, from the client's socket to Copilot's and back.
//
// Everything else in this directory calls a chain, a stage or a helper directly, against a
// provider that is a stub. What no such test can state is that the *dial* works: a provider's
// own boundary shapes the body it is handed — Copilot rewrites tool definitions, strips the
// fields its endpoint rejects, compresses inline images and re-stamps item ids — and the
// record that body is built from is deep-frozen. A body handed over as a shallow copy
// satisfies every type in the system and throws at the first write into a nested node,
// answering the client with a 502 raised where nothing can explain it. So this drives the
// real route against a Copilot upstream and reads what the client would read.

import { expect, test } from 'vitest';

import { copilotModels, requestApp, setupAppTest, sseOpenAIResponsesResponse } from '../../test-utils/app.ts';
import { jsonResponse, withMockedFetch } from '@floway-dev/test-utils';

const ANSWER = 'hello from copilot';

/** A Copilot seat, as far as a turn can see it: the editor version probe, the token exchange,
 *  the catalog, and one data-plane endpoint whose answer the row decides. */
const withCopilot = async <T>(
  models: Parameters<typeof copilotModels>[0],
  serve: (path: string, body: Record<string, unknown>) => Response,
  run: () => Promise<T>,
): Promise<T> =>
  await withMockedFetch(
    async request => {
      const url = new URL(request.url);
      if (url.hostname === 'update.code.visualstudio.com') return jsonResponse(['1.110.1']);
      if (url.pathname === '/copilot_internal/v2/token') {
        return jsonResponse({ token: 'copilot-access-token', expires_at: 4102444800, refresh_in: 3600, endpoints: { api: 'https://api.individual.githubcopilot.com' } });
      }
      if (url.pathname === '/models') return jsonResponse(copilotModels(models));
      return serve(url.pathname, await request.json() as Record<string, unknown>);
    },
    run,
  );

const post = async (apiKey: string, body: Record<string, unknown>): Promise<Response> =>
  await requestApp('/v1/responses', {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-api-key': apiKey },
    body: JSON.stringify(body),
  });

test('a turn reaches Copilot over its own OpenAI Responses endpoint and comes back as one response', async () => {
  const { apiKey } = await setupAppTest();

  let sent: Record<string, unknown> | undefined;
  const response = await withCopilot(
    [{ id: 'gpt-responses', supported_endpoints: ['/responses'] }],
    (path, body) => {
      expect(path).toBe('/responses');
      sent = body;
      return sseOpenAIResponsesResponse({
        id: 'resp_route',
        object: 'response',
        model: 'gpt-responses',
        status: 'completed',
        output: [{
          type: 'message', id: 'msg_route', role: 'assistant', status: 'completed',
          content: [{ type: 'output_text', text: ANSWER, annotations: [] }],
        }],
        error: null,
        incomplete_details: null,
        usage: { input_tokens: 11, output_tokens: 7, total_tokens: 18 },
      });
    },
    async () => await post(apiKey.key, {
      model: 'gpt-responses',
      // Everything the Copilot boundary has an opinion about, so the body it was handed is one
      // it rewrote rather than one it merely forwarded: a namespace tool whose empty
      // description it fills, an image-generation tool its endpoint rejects, a service tier it
      // does not expose, and the snapshot hint it refuses.
      input: [{ type: 'message', role: 'user', content: [{ type: 'input_text', text: 'hi' }] }],
      tools: [
        { type: 'namespace', name: 'repo', description: '', tools: [] },
        { type: 'image_generation' },
      ],
      service_tier: 'flex',
      store: true,
    }),
  );

  // The regression this fences is a 502 whose body reads `Cannot add property …, object is not
  // extensible`: the provider writing into a body whose nested nodes were still the record's.
  expect(response.status).toBe(200);

  const body = await response.json() as {
    object: string;
    status: string;
    output: { type: string; content?: { type: string; text: string }[] }[];
    usage: { input_tokens: number; output_tokens: number };
  };
  expect(body.object).toBe('response');
  expect(body.status).toBe('completed');
  expect(body.output.find(item => item.type === 'message')?.content?.[0]?.text).toBe(ANSWER);
  expect(body.usage).toMatchObject({ input_tokens: 11, output_tokens: 7 });

  // What the turn looked like on the wire. The hosted image-generation tool never reached the
  // Copilot boundary that would have dropped it: Copilot carries the
  // `openai-responses-image-generation-shim` flag, so the server-tool stage got there first and sent a
  // function tool the model can call and this gateway executes. What the boundary did make of
  // the rest is here — the description its namespace tool needs is filled, and neither field it
  // refuses travels.
  const tools = sent?.tools as { type: string; name?: string; description?: string }[];
  expect(tools.map(tool => tool.type)).toEqual(['namespace', 'function']);
  expect(tools[0]!.description).toBe('Tools in the repo namespace.');
  expect(tools[1]!.name).toBe('image_generation');
  expect(sent).not.toHaveProperty('service_tier');
  expect(sent).toMatchObject({ store: false });
});
