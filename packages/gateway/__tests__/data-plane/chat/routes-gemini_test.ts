// `/v1beta/models/:model:generateContent`, from the client's socket to Copilot's and back.
//
// The same statement the other two route files make, for the one family with no wire of its
// own: the provider surface has no Gemini call, so every candidate is reached through a
// translation and each row here is already a translated turn. What the last row adds is the
// second pair — the same request answered over a Messages-only candidate — because "the client
// gets its own protocol back" has to hold for whichever wire the picker landed on.
//
// Gemini also ends a turn differently from either OpenAI-shaped protocol: there is no
// sentinel, and the last frame is the one whose candidate states a `finishReason`.

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

/** The answer a Chat Completions upstream gives, as the SSE every chat endpoint really speaks.
 *  Gemini's first-preference wire, so this is what most of these turns are dialled on. */
const openaiChatCompletionsTurn = (): Response =>
  sseOpenAIChatCompletionsResponse({
    id: 'chatcmpl_route',
    object: 'chat.completion',
    created: 1_772_000_000,
    model: 'gpt-route',
    choices: [{ index: 0, message: { role: 'assistant', content: ANSWER }, finish_reason: 'stop' }],
    usage: { prompt_tokens: 21, completion_tokens: 3, total_tokens: 24 },
  });

const post = async (apiKey: string, modelAction: string): Promise<Response> =>
  await requestApp(`/v1beta/models/${modelAction}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-api-key': apiKey },
    body: JSON.stringify({ contents: [{ role: 'user', parts: [{ text: 'hi' }] }] }),
  });

interface GeminiGenerateContentEvent {
  readonly candidates?: readonly {
    readonly content: { readonly parts: readonly { readonly text?: string }[] };
    readonly finishReason?: string;
  }[];
}

const geminiGenerateContentText = (event: GeminiGenerateContentEvent): string =>
  (event.candidates ?? []).flatMap(candidate => candidate.content.parts.map(part => part.text ?? '')).join('');

test('a streaming turn reaches the client as Gemini SSE, ending on the frame that states a finish reason', async () => {
  const { apiKey } = await setupAppTest();

  const response = await withCopilot(
    [{ id: 'gpt-route', supported_endpoints: ['/chat/completions'] }],
    (path, body) => {
      expect(path).toBe('/chat/completions');
      // Gemini has no wire of its own, so what left the gateway is the translated turn — a
      // Chat Completions body, streaming because every chat endpoint here does.
      expect(body.messages).toBeDefined();
      expect(body.stream).toBe(true);
      return openaiChatCompletionsTurn();
    },
    async () => await post(apiKey.key, 'gpt-route:streamGenerateContent'),
  );

  expect(response.status).toBe(200);
  expect(response.headers.get('content-type')?.split(';')[0]).toBe('text/event-stream');

  const frames = parseSSEText(await response.text());
  expect(frames.length > 0).toBe(true);
  // One JSON object per `data:` line, and no sentinel — Gemini has none to write, so a `[DONE]`
  // here would be a frame no Google client can parse.
  const events = frames.map(frame => JSON.parse(frame.data) as GeminiGenerateContentEvent);
  for (const frame of frames) expect(frame.event).toBe('message');
  expect(events.map(geminiGenerateContentText).join('')).toBe(ANSWER);
  // The turn's end is stated on the frames the client is handed, not on the wire below them.
  expect(events.at(-1)?.candidates?.[0]?.finishReason).toBe('STOP');
  expect(events.slice(0, -1).every(event => event.candidates?.[0]?.finishReason === undefined)).toBe(true);
});

test('a non-streaming turn reaches the client as one assembled Gemini body', async () => {
  const { apiKey } = await setupAppTest();

  const response = await withCopilot(
    [{ id: 'gpt-route', supported_endpoints: ['/chat/completions'] }],
    () => openaiChatCompletionsTurn(),
    async () => await post(apiKey.key, 'gpt-route:generateContent'),
  );

  expect(response.status).toBe(200);
  expect(response.headers.get('content-type')?.split(';')[0]).toBe('application/json');

  const body = await response.json() as GeminiGenerateContentEvent & { usageMetadata?: { promptTokenCount?: number; candidatesTokenCount?: number } };
  expect(body.candidates).toHaveLength(1);
  expect(body.candidates?.[0].finishReason).toBe('STOP');
  expect(geminiGenerateContentText(body)).toBe(ANSWER);
  // What the upstream metered is stated to the client too, in this protocol's own names.
  expect(body.usageMetadata?.promptTokenCount).toBe(21);
  expect(body.usageMetadata?.candidatesTokenCount).toBe(3);
});

test('an upstream refusal reaches the client in this protocol-s own envelope', async () => {
  const { apiKey } = await setupAppTest();
  const refusal = { error: { message: 'copilot said no', type: 'insufficient_quota', code: 'quota_exceeded' } };

  const response = await withCopilot(
    [{ id: 'gpt-route', supported_endpoints: ['/chat/completions'] }],
    () => jsonResponse(refusal, 402),
    async () => await post(apiKey.key, 'gpt-route:generateContent'),
  );

  // The status the upstream sent, with none of the coercion a Google-RPC envelope would force
  // onto the codes it cannot express.
  expect(response.status).toBe(402);

  // Gemini has no wire of its own, so every refusal that gets here was written by whatever
  // protocol the candidate was dialled on — here OpenAI's. Handing that object on would answer
  // a Gemini client in another protocol's words: `error.status` is the field its SDKs read and
  // an OpenAI envelope has none, while `error.code` would arrive as a string where a number
  // belongs. So the upstream's words become the message and this protocol writes the shape.
  const body = await response.json() as { error: { code: number; message: string; status: string } };
  expect(body.error.code).toBe(402);
  // The Google-RPC name for the status, which is the field an SDK branches on. A code this
  // envelope cannot express reads `INTERNAL`, and 402 is one of them.
  expect(body.error.status).toBe('INTERNAL');
  expect(body.error.message).toContain('copilot said no');
});

test('a refusal on a turn that asked to stream is a body, not an opened stream', async () => {
  const { apiKey } = await setupAppTest();
  const refusal = { error: { message: 'copilot said no', type: 'insufficient_quota' } };

  // The riskier half of the same statement: the client asked for SSE, so the seam has a
  // stream to open and must not — nothing was ever generated, and a Gemini stream that
  // carried the refusal would be read as a turn that produced no candidates.
  const response = await withCopilot(
    [{ id: 'gpt-route', supported_endpoints: ['/chat/completions'] }],
    () => jsonResponse(refusal, 402),
    async () => await post(apiKey.key, 'gpt-route:streamGenerateContent'),
  );

  expect(response.status).toBe(402);
  expect(response.headers.get('content-type')?.split(';')[0]).toBe('application/json');
  const body = await response.json() as { error: { code: number; message: string; status: string } };
  expect(body.error.code).toBe(402);
  expect(body.error.message).toContain('copilot said no');
});

test('a served turn writes one usage row carrying the tokens the upstream reported', async () => {
  const { apiKey, repo } = await setupAppTest();

  const response = await withCopilot(
    [{ id: 'gpt-route', supported_endpoints: ['/chat/completions'] }],
    () => openaiChatCompletionsTurn(),
    async () => {
      const answer = await post(apiKey.key, 'gpt-route:streamGenerateContent');
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
  // The reading is taken on the dialect the upstream actually spoke, which for this family is
  // always a translated one — and the two regressions this fences are a row written with no
  // metrics at all and a row written with every quantity at zero.
  expect(tokenCountsFromUsage(rows[0])).toEqual({ input: 21, output: 3 });
});

test('a turn dialled over the Messages wire still answers the client in Gemini', async () => {
  const { apiKey, repo } = await setupAppTest();

  // The candidate serves `/messages` and nothing else, so the picker's first preference is
  // unavailable and the turn leaves through the other pair. A chain that dialled anything else
  // would call a Copilot method with no upstream mocked here.
  const response = await withCopilot(
    [{ id: 'anthropic-route', supported_endpoints: ['/messages'] }],
    (path, body) => {
      expect(path).toBe('/v1/messages');
      expect(body.messages).toBeDefined();
      expect(body.stream).toBe(true);
      return sseAnthropicMessagesResponse({
        id: 'msg_route',
        type: 'message',
        role: 'assistant',
        model: 'anthropic-route',
        content: [{ type: 'text', text: ANSWER }],
        stop_reason: 'end_turn',
        usage: { input_tokens: 8, output_tokens: 2 },
      });
    },
    async () => await post(apiKey.key, 'anthropic-route:generateContent'),
  );

  expect(response.status).toBe(200);
  const body = await response.json() as GeminiGenerateContentEvent;
  expect(body.candidates).toHaveLength(1);
  expect(body.candidates?.[0].finishReason).toBe('STOP');
  expect(geminiGenerateContentText(body)).toBe(ANSWER);

  await flushBackground();
  const rows = await repo.usage.listAll();
  expect(rows).toHaveLength(1);
  expect(tokenCountsFromUsage(rows[0])).toEqual({ input: 8, output: 2 });
});
