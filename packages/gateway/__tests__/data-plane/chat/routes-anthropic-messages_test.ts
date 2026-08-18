// `/v1/messages`, from the client's socket to Copilot's and back.
//
// The same statement the OpenAI Chat Completions route file makes, for the protocol Claude Code
// speaks. Two things are this family's own and are said here rather than assumed: Anthropic
// ends a turn with an event rather than a transport sentinel, so `message_stop` is what the
// terminal assertion looks for; and the edge writes the turn's own affinity state into the
// answer as a leading `redacted_thinking` block, so the text is found by kind rather than at
// index zero.

import { expect, test } from 'vitest';

import { tokenCountsFromUsage } from '../../../src/repo/usage-metrics.ts';
import { copilotModels, parseSSEText, requestApp, setupAppTest, sseOpenAIChatCompletionsResponse, sseAnthropicMessagesResponse } from '../../test-utils/app.ts';
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

/** The answer an Anthropic Messages upstream gives, as the SSE every chat endpoint really speaks. */
const upstreamTurn = (model: string): Response =>
  sseAnthropicMessagesResponse({
    id: 'msg_route',
    type: 'message',
    role: 'assistant',
    model,
    content: [{ type: 'text', text: ANSWER }],
    stop_reason: 'end_turn',
    usage: { input_tokens: 17, output_tokens: 4 },
  });

const post = async (apiKey: string, body: Record<string, unknown>): Promise<Response> =>
  await requestApp('/v1/messages', {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-api-key': apiKey },
    body: JSON.stringify(body),
  });

const turn = (model: string, extra: Record<string, unknown> = {}): Record<string, unknown> =>
  ({ model, max_tokens: 64, messages: [{ role: 'user', content: 'hi' }], ...extra });

interface AnthropicMessagesBody {
  readonly type: string;
  readonly role: string;
  readonly stop_reason: string;
  readonly content: readonly { readonly type: string; readonly text?: string }[];
  readonly usage: { readonly input_tokens: number; readonly output_tokens: number };
}

/** The answer's own text, past the carrier the edge writes back. */
const textOf = (body: AnthropicMessagesBody): string | undefined =>
  body.content.find(block => block.type === 'text')?.text;

test('a streaming turn reaches the client as Anthropic Messages SSE, message_stop included', async () => {
  const { apiKey } = await setupAppTest();

  const response = await withCopilot(
    [{ id: 'anthropic-route', supported_endpoints: ['/messages'] }],
    (path, body) => {
      expect(path).toBe('/v1/messages');
      // The provider forces streaming on every chat endpoint, so what the client asked for is
      // not what the wire carries.
      expect(body.stream).toBe(true);
      return upstreamTurn('anthropic-route');
    },
    async () => await post(apiKey.key, turn('anthropic-route', { stream: true })),
  );

  expect(response.status).toBe(200);
  expect(response.headers.get('content-type')?.split(';')[0]).toBe('text/event-stream');

  const frames = parseSSEText(await response.text());
  // Anthropic names its own SSE events, and every frame the client reads carries the name of
  // the event its data states.
  for (const frame of frames) {
    expect(frame.event).toBe((JSON.parse(frame.data) as { type: string }).type);
  }
  expect(frames[0].event).toBe('message_start');
  // The turn ends with an event rather than a transport sentinel — there is no `[DONE]` here,
  // and a stream that stopped before this one is an answer nobody can act on.
  expect(frames.at(-1)?.event).toBe('message_stop');

  const text = frames
    .filter(frame => frame.event === 'content_block_delta')
    .map(frame => (JSON.parse(frame.data) as { delta: { text?: string } }).delta.text ?? '')
    .join('');
  expect(text).toBe(ANSWER);
});

test('a non-streaming turn reaches the client as one assembled Anthropic Messages body', async () => {
  const { apiKey } = await setupAppTest();

  const response = await withCopilot(
    [{ id: 'anthropic-route', supported_endpoints: ['/messages'] }],
    () => upstreamTurn('anthropic-route'),
    async () => await post(apiKey.key, turn('anthropic-route')),
  );

  expect(response.status).toBe(200);
  expect(response.headers.get('content-type')?.split(';')[0]).toBe('application/json');

  const body = await response.json() as AnthropicMessagesBody;
  expect(body.type).toBe('message');
  expect(body.role).toBe('assistant');
  expect(body.stop_reason).toBe('end_turn');
  expect(textOf(body)).toBe(ANSWER);
  // What the upstream metered is stated to the client too, and it is the same reading the
  // usage row below is written from.
  expect(body.usage.input_tokens).toBe(17);
  expect(body.usage.output_tokens).toBe(4);
});

test('an upstream refusal reaches the client in the upstream-s own words and status', async () => {
  const { apiKey } = await setupAppTest();
  const refusal = { type: 'error', error: { type: 'permission_error', message: 'copilot said no' } };

  const response = await withCopilot(
    [{ id: 'anthropic-route', supported_endpoints: ['/messages'] }],
    () => jsonResponse(refusal, 403),
    async () => await post(apiKey.key, turn('anthropic-route')),
  );

  expect(response.status).toBe(403);
  // Not the gateway's own `{ type: 'error', error: { type: 'api_error', … } }` — the answer to
  // "why was I refused" is the refusing party's to give.
  expect(await response.json()).toEqual(refusal);
});

test('a refusal on a turn that asked to stream is a body, not an opened stream', async () => {
  const { apiKey } = await setupAppTest();
  const refusal = { type: 'error', error: { type: 'permission_error', message: 'copilot said no' } };

  // The riskier half of the same statement: the client asked for SSE, so the seam has a
  // stream to open and must not — nothing was ever generated, and Claude Code reads an error
  // written into a 200 stream as a turn that succeeded and said nothing.
  const response = await withCopilot(
    [{ id: 'anthropic-route', supported_endpoints: ['/messages'] }],
    () => jsonResponse(refusal, 403),
    async () => await post(apiKey.key, turn('anthropic-route', { stream: true })),
  );

  expect(response.status).toBe(403);
  expect(response.headers.get('content-type')?.split(';')[0]).toBe('application/json');
  expect(await response.json()).toEqual(refusal);
});

test('a served turn writes one usage row carrying the tokens the upstream reported', async () => {
  const { apiKey, repo } = await setupAppTest();

  const response = await withCopilot(
    [{ id: 'anthropic-route', supported_endpoints: ['/messages'] }],
    () => upstreamTurn('anthropic-route'),
    async () => {
      const answer = await post(apiKey.key, turn('anthropic-route', { stream: true }));
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
  expect(tokenCountsFromUsage(rows[0])).toEqual({ input: 17, output: 4 });
});

test('a turn dialled over the OpenAI Chat Completions wire still answers the client in Anthropic Messages', async () => {
  const { apiKey, repo } = await setupAppTest();

  // The candidate serves `/chat/completions` and nothing else, so neither this protocol's own
  // wire nor the OpenAI Responses one is available and the turn leaves through the handoff. A chain
  // that dialled anything else would call a Copilot method with no upstream mocked here.
  const response = await withCopilot(
    [{ id: 'gpt-route', supported_endpoints: ['/chat/completions'] }],
    (path, body) => {
      expect(path).toBe('/chat/completions');
      // The usage chunk is asked for by the wire the turn landed on, not by the chain it
      // arrived from — which is what keeps a translated turn metered at all.
      expect(body.stream_options).toEqual({ include_usage: true });
      return sseOpenAIChatCompletionsResponse({
        id: 'chatcmpl_route',
        object: 'chat.completion',
        created: 1_772_000_000,
        model: 'gpt-route',
        choices: [{ index: 0, message: { role: 'assistant', content: ANSWER }, finish_reason: 'stop' }],
        usage: { prompt_tokens: 9, completion_tokens: 6, total_tokens: 15 },
      });
    },
    async () => await post(apiKey.key, turn('gpt-route')),
  );

  expect(response.status).toBe(200);
  const body = await response.json() as AnthropicMessagesBody;
  expect(body.type).toBe('message');
  expect(body.role).toBe('assistant');
  expect(body.stop_reason).toBe('end_turn');
  expect(textOf(body)).toBe(ANSWER);

  // The reading is taken on the dialect the upstream actually spoke, so a translated turn is
  // metered like any other rather than billing nothing.
  await flushBackground();
  const rows = await repo.usage.listAll();
  expect(rows).toHaveLength(1);
  expect(tokenCountsFromUsage(rows[0])).toEqual({ input: 9, output: 6 });
});
