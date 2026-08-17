// `/v1/chat/completions`, from the client's socket to Copilot's and back.
//
// Everything else in this directory calls a chain, a stage or a helper directly. What no such
// test can state is that the route *works*: the parts it skips — the provider's own boundary
// interceptors, the fetcher, the epilogue that writes the client's bytes and settles what the
// stream billed — are exactly where a turn has been lost before. So each row here drives the
// real Hono route against a Copilot upstream, reads the bytes the client would read, and says
// something about them that a broken chain could not produce.

import { expect, test } from 'vitest';

import { tokenCountsFromUsage } from '../../../src/repo/usage-metrics.ts';
import { copilotModels, parseSSEText, requestApp, setupAppTest, sseChatCompletionsResponse, sseMessagesResponse } from '../../test-utils/app.ts';
import { flushBackground } from '../../test-utils/background-tracker.ts';
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

/** The answer a Chat Completions upstream gives, as the SSE every chat endpoint really speaks. */
const upstreamTurn = (model: string): Response =>
  sseChatCompletionsResponse({
    id: 'chatcmpl_route',
    object: 'chat.completion',
    created: 1_772_000_000,
    model,
    choices: [{ index: 0, message: { role: 'assistant', content: ANSWER }, finish_reason: 'stop' }],
    usage: { prompt_tokens: 11, completion_tokens: 7, total_tokens: 18 },
  });

const post = async (apiKey: string, body: Record<string, unknown>): Promise<Response> =>
  await requestApp('/v1/chat/completions', {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-api-key': apiKey },
    body: JSON.stringify(body),
  });

interface ChatChunk {
  readonly object: string;
  readonly choices: readonly { readonly delta?: { readonly content?: string }; readonly finish_reason: string | null }[];
}

test('a streaming turn reaches the client as Chat Completions SSE, terminator included', async () => {
  const { apiKey } = await setupAppTest();

  const response = await withCopilot(
    [{ id: 'gpt-route', supported_endpoints: ['/chat/completions'] }],
    (path, body) => {
      expect(path).toBe('/chat/completions');
      // The provider forces streaming on every chat endpoint, so what the client asked for is
      // not what the wire carries — and the marker below is the Copilot boundary chain having
      // run on a body it was free to write into.
      expect(body.stream).toBe(true);
      return upstreamTurn('gpt-route');
    },
    async () => await post(apiKey.key, { model: 'gpt-route', messages: [{ role: 'user', content: 'hi' }], stream: true }),
  );

  expect(response.status).toBe(200);
  expect(response.headers.get('content-type')?.split(';')[0]).toBe('text/event-stream');

  const frames = parseSSEText(await response.text());
  expect(frames.length > 1).toBe(true);
  // The sentinel is what an OpenAI client reads as the end of the turn; a stream that stopped
  // without it is a truncated answer presented as a whole one.
  expect(frames.at(-1)?.data).toBe('[DONE]');

  const chunks = frames.slice(0, -1).map(frame => JSON.parse(frame.data) as ChatChunk);
  for (const chunk of chunks) expect(chunk.object).toBe('chat.completion.chunk');
  expect(chunks.map(chunk => chunk.choices[0]?.delta?.content ?? '').join('')).toBe(ANSWER);
  expect(chunks.some(chunk => chunk.choices[0]?.finish_reason === 'stop')).toBe(true);
});

test('a non-streaming turn reaches the client as one assembled Chat Completions body', async () => {
  const { apiKey } = await setupAppTest();

  const response = await withCopilot(
    [{ id: 'gpt-route', supported_endpoints: ['/chat/completions'] }],
    () => upstreamTurn('gpt-route'),
    async () => await post(apiKey.key, { model: 'gpt-route', messages: [{ role: 'user', content: 'hi' }] }),
  );

  expect(response.status).toBe(200);
  expect(response.headers.get('content-type')?.split(';')[0]).toBe('application/json');

  const body = await response.json() as {
    object: string;
    choices: { index: number; message: { role: string; content: string }; finish_reason: string }[];
    usage: { prompt_tokens: number; completion_tokens: number };
  };
  expect(body.object).toBe('chat.completion');
  expect(body.choices).toHaveLength(1);
  expect(body.choices[0].message.role).toBe('assistant');
  expect(body.choices[0].message.content).toBe(ANSWER);
  expect(body.choices[0].finish_reason).toBe('stop');
  // What the upstream metered is stated to the client too, and it is the same reading the
  // usage row below is written from.
  expect(body.usage.prompt_tokens).toBe(11);
  expect(body.usage.completion_tokens).toBe(7);
});

test('an upstream refusal reaches the client in the upstream-s own words and status', async () => {
  const { apiKey } = await setupAppTest();
  const refusal = { error: { message: 'copilot said no', type: 'insufficient_quota', code: 'quota_exceeded' } };

  const response = await withCopilot(
    [{ id: 'gpt-route', supported_endpoints: ['/chat/completions'] }],
    () => jsonResponse(refusal, 402),
    async () => await post(apiKey.key, { model: 'gpt-route', messages: [{ role: 'user', content: 'hi' }] }),
  );

  expect(response.status).toBe(402);
  // Not `{ error: { message, type: 'api_error' } }` — the answer to "why was I refused" is the
  // refusing party's to give, so the gateway forwards it rather than quoting it.
  expect(await response.json()).toEqual(refusal);
});

test('a served turn writes one usage row carrying the tokens the upstream reported', async () => {
  const { apiKey, repo } = await setupAppTest();

  const response = await withCopilot(
    [{ id: 'gpt-route', supported_endpoints: ['/chat/completions'] }],
    () => upstreamTurn('gpt-route'),
    async () => {
      const answer = await post(apiKey.key, { model: 'gpt-route', messages: [{ role: 'user', content: 'hi' }], stream: true });
      // A stream's numbers arrive with its last chunk, so the row is written after the client
      // has read it — a test that never read the body would settle nothing.
      await answer.text();
      return answer;
    },
  );

  expect(response.status).toBe(200);
  await flushBackground();

  const rows = await repo.usage.listAll();
  expect(rows).toHaveLength(1);
  expect(rows[0].keyId).toBe(apiKey.id);
  expect(rows[0].requests).toBe(1);
  // The two regressions this fences: a row written with no metrics at all, and a row written
  // with every quantity at zero.
  expect(tokenCountsFromUsage(rows[0])).toEqual({ input: 11, output: 7 });
});

test('a turn dialled over the Messages wire still answers the client in Chat Completions', async () => {
  const { apiKey, repo } = await setupAppTest();

  // The candidate serves `/messages` and nothing else, so the picker's first preference — this
  // protocol's own wire — is unavailable and the turn leaves through the handoff. A chain that
  // dialled anything else would call a Copilot method that has no upstream mocked here.
  const response = await withCopilot(
    [{ id: 'anthropic-route', supported_endpoints: ['/messages'] }],
    (path, body) => {
      expect(path).toBe('/v1/messages');
      expect(body.stream).toBe(true);
      return sseMessagesResponse({
        id: 'msg_route',
        type: 'message',
        role: 'assistant',
        model: 'anthropic-route',
        content: [{ type: 'text', text: ANSWER }],
        stop_reason: 'end_turn',
        usage: { input_tokens: 13, output_tokens: 5 },
      });
    },
    async () => await post(apiKey.key, { model: 'anthropic-route', messages: [{ role: 'user', content: 'hi' }] }),
  );

  expect(response.status).toBe(200);
  const body = await response.json() as {
    object: string;
    choices: { message: { role: string; content: string }; finish_reason: string }[];
  };
  expect(body.object).toBe('chat.completion');
  expect(body.choices[0].message.role).toBe('assistant');
  expect(body.choices[0].message.content).toBe(ANSWER);
  expect(body.choices[0].finish_reason).toBe('stop');

  // The reading is taken on the dialect the upstream actually spoke, so a translated turn is
  // metered like any other rather than billing nothing.
  await flushBackground();
  const rows = await repo.usage.listAll();
  expect(rows).toHaveLength(1);
  expect(tokenCountsFromUsage(rows[0])).toEqual({ input: 13, output: 5 });
});
