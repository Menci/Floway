// The frames a chat turn was served are in its run record.
//
// A run record that holds only stage boundaries describes the shape of the turn and none of
// its content, and the dashboard's collected view is assembled by replaying exactly these
// events. The tee sits at the family's edge, so what lands in the record is the source
// protocol's frames — what the client read — rather than whatever the upstream spoke.

import { test, vi } from 'vitest';

import { initDumpBroker, initDumpStore } from '../../../src/dump/registry.ts';
import { eventsOf, installDumpStubs, runRecordOf } from '../../dump/test-fixtures.ts';
import { copilotModels, flushAsyncWork, requestApp, setupAppTest, sseChatCompletionsResponse } from '../../test-utils/app.ts';
import { assertEquals, assertExists, jsonResponse, withMockedFetch } from '@floway-dev/test-utils';

const withChatCompletionsUpstream = async <T>(run: () => Promise<T>): Promise<T> =>
  await withMockedFetch(
    async request => {
      const url = new URL(request.url);
      if (url.hostname === 'update.code.visualstudio.com') return jsonResponse(['1.110.1']);
      if (url.pathname === '/copilot_internal/v2/token') {
        return jsonResponse({ token: 'copilot-access-token', expires_at: 4102444800, refresh_in: 3600, endpoints: { api: 'https://api.individual.githubcopilot.com' } });
      }
      if (url.pathname === '/models') {
        return jsonResponse(copilotModels([{ id: 'gpt-frames', supported_endpoints: ['/chat/completions'] }]));
      }
      if (url.pathname === '/chat/completions') {
        return sseChatCompletionsResponse({
          id: 'chatcmpl_frames',
          object: 'chat.completion',
          model: 'gpt-frames',
          choices: [{ index: 0, message: { role: 'assistant', content: 'hello there' }, finish_reason: 'stop' }],
          usage: { prompt_tokens: 3, completion_tokens: 5, total_tokens: 8 },
        });
      }
      throw new Error(`Unhandled fetch ${request.url}`);
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

const recordedFramesOf = async (stream: boolean): Promise<readonly unknown[]> => {
  const { apiKey, repo } = await setupAppTest();
  await repo.apiKeys.save({ ...apiKey, dumpRetentionSeconds: 3600 });
  const dumps = installDumpStubs(initDumpStore, initDumpBroker);

  await withChatCompletionsUpstream(async () => {
    const response = await requestApp('/v1/chat/completions', {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-api-key': apiKey.key },
      body: JSON.stringify({ model: 'gpt-frames', messages: [{ role: 'user', content: 'hi' }], stream }),
    });
    assertEquals(response.status, 200);
    // Reading is what records, so a test that never read the body would prove the opposite of
    // what it claims.
    await response.text();
  });

  await flushAsyncWork();
  await vi.waitFor(() => assertEquals(dumps.stored.length, 1));
  const stored = dumps.stored[0];
  assertExists(stored);
  return resolveFrames(eventsOf(runRecordOf(stored.record)));
};

test('a streamed chat turn records the frames it served', async () => {
  const frames = await recordedFramesOf(true);
  assertEquals(frames.length > 0, true);
  // The content is the point, not the count: a record holding frames with nothing in them is
  // the same empty record with more events.
  assertEquals(JSON.stringify(frames).includes('hello there'), true);
});

test('a collected chat turn records the frames it was assembled from', async () => {
  // 「流式请求前端看到流+前端组装结果，非流式请求前端看到流+原始组装结果」 — the frames are
  // recorded either way, which is what lets the operator see the stream behind a single body.
  const frames = await recordedFramesOf(false);
  assertEquals(frames.length > 0, true);
  assertEquals(JSON.stringify(frames).includes('hello there'), true);
});
