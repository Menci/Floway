// A pipelined chat turn over HTTP is recorded as its whole run, the same way the WebSocket
// transport records one. The two entries share `openChatPrologue`, and the sink it opens is
// the only thing that turns a recording into events — without it a key with retention
// configured pays for a record holding nothing but its metadata.

import { test, vi } from 'vitest';

import { initDumpBroker, initDumpStore } from '../../../../src/dump/registry.ts';
import { eventsOf, installDumpStubs, runRecordOf } from '../../../dump/test-fixtures.ts';
import { copilotModels, flushAsyncWork, requestApp, setupAppTest, sseOpenAIResponsesResponse } from '../../../test-utils/app.ts';
import { assertEquals, assertExists, jsonResponse, withMockedFetch } from '@floway-dev/test-utils';

const withOpenAIResponsesUpstream = async <T>(run: () => Promise<T>): Promise<T> =>
  await withMockedFetch(
    async request => {
      const url = new URL(request.url);
      if (url.hostname === 'update.code.visualstudio.com') return jsonResponse(['1.110.1']);
      if (url.pathname === '/copilot_internal/v2/token') {
        return jsonResponse({ token: 'copilot-access-token', expires_at: 4102444800, refresh_in: 3600, endpoints: { api: 'https://api.individual.githubcopilot.com' } });
      }
      if (url.pathname === '/models') {
        return jsonResponse(copilotModels([{ id: 'gpt-direct-responses', supported_endpoints: ['/responses'] }]));
      }
      if (url.pathname === '/responses') {
        return sseOpenAIResponsesResponse({
          id: 'resp_run_dump',
          object: 'response',
          model: 'gpt-direct-responses',
          status: 'completed',
          output: [],
          output_text: 'done',
          usage: { input_tokens: 3, output_tokens: 5, total_tokens: 8 },
        });
      }
      throw new Error(`Unhandled fetch ${request.url}`);
    },
    run,
  );

test('POST /v1/responses records the run it was, not an empty record', async () => {
  const { apiKey, repo } = await setupAppTest();
  await repo.apiKeys.save({ ...apiKey, dumpRetentionSeconds: 3600 });
  const dumps = installDumpStubs(initDumpStore, initDumpBroker);

  await withOpenAIResponsesUpstream(async () => {
    const response = await requestApp('/v1/responses', {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-api-key': apiKey.key },
      body: JSON.stringify({ model: 'gpt-direct-responses', input: 'hello', stream: false }),
    });
    assertEquals(response.status, 200);
    await response.json();
  });

  await flushAsyncWork();
  await vi.waitFor(() => assertEquals(dumps.stored.length, 1));

  const stored = dumps.stored[0];
  assertExists(stored);
  const record = runRecordOf(stored.record);
  assertEquals(record.meta.path, '/v1/responses');

  // The events are the point: a recording whose sink was never handed to the runner still
  // produces a record, and it holds nothing. Every run enters and leaves at least one stage.
  const events = eventsOf(record);
  assertEquals(events.length > 0, true);
  assertEquals(events.some(event => event.type === 'stage.entered'), true);
  assertEquals(events.some(event => event.type === 'stage.leaved'), true);
});
