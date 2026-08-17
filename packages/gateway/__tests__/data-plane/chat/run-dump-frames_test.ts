// The frames a chat turn was served are in its run record.
//
// A run record that holds only stage boundaries describes the shape of the turn and none of
// its content, and the dashboard's collected view is assembled by replaying exactly these
// events. The tee sits at the family's edge, so what lands in the record is the source
// protocol's frames — what the client read — rather than whatever the upstream spoke.
//
// Every edge that hands a client frames is covered here, in both shapes the client can be
// handed them: the stream itself, and the one body the same frames were folded into.
// `/v1/responses/compact` is one of those edges rather than a wire under the generate chain —
// it reads its frames itself, so recording them is its own to do — and it only ever folds,
// because a compaction is one resource.

import { test, vi } from 'vitest';

import { initDumpBroker, initDumpStore } from '../../../src/dump/registry.ts';
import { eventsOf, installDumpStubs, runRecordOf } from '../../dump/test-fixtures.ts';
import { copilotModels, flushAsyncWork, requestApp, setupAppTest, sseChatCompletionsResponse, sseResponsesResponse } from '../../test-utils/app.ts';
import { assertEquals, assertExists, jsonResponse, withMockedFetch } from '@floway-dev/test-utils';

/** A Copilot seat, as far as a turn can see it: the editor version probe, the token exchange,
 *  the catalog, and one data-plane endpoint whose answer each turn decides for itself. */
const withCopilot = async <T>(
  models: Parameters<typeof copilotModels>[0],
  serve: (request: Request) => Promise<Response> | Response,
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
      return await serve(request);
    },
    run,
  );

// The run format interns every node it has seen, so a frame arrives as a reference into the
// table the `object` events build up. Resolving it here is what makes the assertion about the
// frame's content rather than about an event existing.
const resolveFrames = (events: readonly Record<string, unknown>[]): unknown[] => {
  const table = new Map<number, unknown>();
  for (const event of events) {
    if (event.type !== 'object') continue;
    const from = event.fromObjectId as number;
    (event.nodes as unknown[]).forEach((node, index) => { table.set(from + index, node); });
  }
  const resolve = (value: unknown): unknown => {
    if (Array.isArray(value)) return value.map(resolve);
    if (typeof value !== 'object' || value === null) return value;
    const record = value as Record<string, unknown>;
    if ('$' in record) return resolve(table.get(record.$ as number));
    return Object.fromEntries(Object.entries(record).map(([key, child]) => [key, resolve(child)]));
  };
  return events
    .filter(event => event.type === 'stream.frame')
    .flatMap(event => (event.frames as unknown[]).map(resolve));
};

/** Runs one turn with a record open, and hands back the frames that record holds.
 *
 *  Reading the client's body is part of the turn rather than an assertion about it: reading is
 *  what records, so a caller that never read would prove the opposite of what these tests
 *  claim. */
const framesRecordedBy = async (turn: (apiKey: string) => Promise<Response>): Promise<readonly unknown[]> => {
  const { apiKey, repo } = await setupAppTest();
  await repo.apiKeys.save({ ...apiKey, dumpRetentionSeconds: 3600 });
  const dumps = installDumpStubs(initDumpStore, initDumpBroker);

  const response = await turn(apiKey.key);
  assertEquals(response.status, 200);
  await response.text();

  await flushAsyncWork();
  await vi.waitFor(() => assertEquals(dumps.stored.length, 1));
  const stored = dumps.stored[0];
  assertExists(stored);
  return resolveFrames(eventsOf(runRecordOf(stored.record)));
};

/** The content is the point, not the count: a record holding frames with nothing in them is
 *  the same empty record with more events. */
const assertFramesCarry = (frames: readonly unknown[], text: string): void => {
  assertEquals(frames.length > 0, true);
  assertEquals(JSON.stringify(frames).includes(text), true);
};

/** The output items the recorded frames closed, which is what a resource assembled from them
 *  is made of. */
const closedItemTypes = (frames: readonly unknown[]): readonly string[] =>
  frames.flatMap(frame => {
    const { event } = frame as { event?: { type?: string; item?: { type?: string } } };
    if (event?.type !== 'response.output_item.done') return [];
    return event.item?.type === undefined ? [] : [event.item.type];
  });

const ANSWER = 'hello there';

const chatCompletionsTurn = (stream: boolean) => async (apiKey: string): Promise<Response> =>
  await withCopilot(
    [{ id: 'gpt-frames', supported_endpoints: ['/chat/completions'] }],
    () => sseChatCompletionsResponse({
      id: 'chatcmpl_frames',
      object: 'chat.completion',
      model: 'gpt-frames',
      choices: [{ index: 0, message: { role: 'assistant', content: ANSWER }, finish_reason: 'stop' }],
      usage: { prompt_tokens: 3, completion_tokens: 5, total_tokens: 8 },
    }),
    async () => await requestApp('/v1/chat/completions', {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-api-key': apiKey },
      body: JSON.stringify({ model: 'gpt-frames', messages: [{ role: 'user', content: 'hi' }], stream }),
    }),
  );

const responsesTurn = (stream: boolean) => async (apiKey: string): Promise<Response> =>
  await withCopilot(
    [{ id: 'gpt-responses-frames', supported_endpoints: ['/responses'] }],
    () => sseResponsesResponse({
      id: 'resp_frames',
      object: 'response',
      model: 'gpt-responses-frames',
      status: 'completed',
      output: [{
        type: 'message', id: 'msg_frames', role: 'assistant', status: 'completed',
        content: [{ type: 'output_text', text: ANSWER, annotations: [] }],
      }],
      error: null,
      incomplete_details: null,
      usage: { input_tokens: 11, output_tokens: 7, total_tokens: 18 },
    }),
    async () => await requestApp('/v1/responses', {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-api-key': apiKey },
      body: JSON.stringify({
        model: 'gpt-responses-frames',
        input: [{ type: 'message', role: 'user', content: [{ type: 'input_text', text: 'hi' }] }],
        stream,
      }),
    }),
  );

/** The history a compaction is asked to stand in for. Copilot's compaction retains the
 *  messages it did not absorb, so this is what the resource carries beside the blob. */
const HISTORY = 'everything that has been said so far';

const compactionTurn = async (apiKey: string): Promise<Response> =>
  await withCopilot(
    [{ id: 'gpt-compact-frames', supported_endpoints: ['/responses'] }],
    // Copilot has no compaction endpoint of its own: it replays the protocol over `/responses`
    // with the trigger appended and `stream: false`, so the answer here is one JSON body.
    () => jsonResponse({
      id: 'resp_compaction',
      object: 'response',
      model: 'gpt-compact-frames',
      status: 'completed',
      output: [{ type: 'compaction', id: 'cmp_frames', encrypted_content: 'OPAQUE_COMPACTION_BLOB' }],
      error: null,
      incomplete_details: null,
      usage: { input_tokens: 21, output_tokens: 4, total_tokens: 25 },
    }),
    async () => await requestApp('/v1/responses/compact', {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-api-key': apiKey },
      body: JSON.stringify({
        model: 'gpt-compact-frames',
        input: [{ type: 'message', role: 'user', content: [{ type: 'input_text', text: HISTORY }] }],
      }),
    }),
  );

test('a streamed chat turn records the frames it served', async () => {
  assertFramesCarry(await framesRecordedBy(chatCompletionsTurn(true)), ANSWER);
});

test('a collected chat turn records the frames it was assembled from', async () => {
  // 「流式请求前端看到流+前端组装结果，非流式请求前端看到流+原始组装结果」 — the frames are
  // recorded either way, which is what lets the operator see the stream behind a single body.
  assertFramesCarry(await framesRecordedBy(chatCompletionsTurn(false)), ANSWER);
});

test('a streamed responses turn records the frames it served', async () => {
  assertFramesCarry(await framesRecordedBy(responsesTurn(true)), ANSWER);
});

test('a collected responses turn records the frames it was assembled from', async () => {
  assertFramesCarry(await framesRecordedBy(responsesTurn(false)), ANSWER);
});

test('a compaction records the frames its resource was assembled from', async () => {
  const frames = await framesRecordedBy(compactionTurn);
  // These frames never reached a client — the client got the one resource they add up to — so
  // the record is the only place the turn's own events survive at all. Both halves of what
  // that resource was assembled from are in them: the history the upstream retained, and the
  // compaction item the next turn inherits.
  assertFramesCarry(frames, HISTORY);
  assertEquals(closedItemTypes(frames).includes('compaction'), true);
});
