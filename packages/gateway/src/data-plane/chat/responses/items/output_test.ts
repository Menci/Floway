import { expect, test } from 'vitest';

import { wrapResponsesOutputForStorage } from './output.ts';
import { createResponsesHttpStore } from './store.ts';
import { ResponsesAttemptState } from '../attempt-state.ts';
import { initRepo } from '../../../../repo/index.ts';
import { InMemoryRepo } from '../../../../repo/memory.ts';
import { doneFrame, eventFrame, type ProtocolFrame } from '@floway-dev/protocols/common';
import type { ResponsesResult, ResponsesStreamEvent } from '@floway-dev/protocols/responses';

const frames = async function* (response: ResponsesResult): AsyncIterable<ProtocolFrame<ResponsesStreamEvent>> {
  const item = response.output[0];
  yield eventFrame({ type: 'response.output_item.added', output_index: 0, item });
  yield eventFrame({ type: 'response.output_item.done', output_index: 0, item });
  yield eventFrame({ type: 'response.completed', response });
  yield doneFrame();
};

test('storage rewrites ids and persists the exact complete client-wire item before terminal', async () => {
  const repo = new InMemoryRepo();
  initRepo(repo);
  const store = createResponsesHttpStore('key-a', true);
  const result: ResponsesResult = {
    id: 'resp_upstream',
    object: 'response',
    model: 'model',
    status: 'completed',
    output: [{ type: 'reasoning', id: 'rs_upstream', summary: [], encrypted_content: 'wrapped-affinity' }],
    error: null,
    incomplete_details: null,
  };

  const events: ResponsesStreamEvent[] = [];
  for await (const frame of wrapResponsesOutputForStorage(frames(result), {
    store,
    attemptState: new ResponsesAttemptState(),
    responseId: 'resp_public',
  })) {
    if (frame.type === 'event') events.push(frame.event);
  }

  const terminal = events.at(-1);
  expect(terminal?.type).toBe('response.completed');
  if (terminal?.type !== 'response.completed') throw new Error('Expected terminal response');
  const publicItem = terminal.response.output[0];
  expect(publicItem.id).not.toBe('rs_upstream');
  const rows = await repo.responsesItems.lookupMany('key-a', [publicItem.id!]);
  expect(rows[0].payload.item).toEqual(publicItem);
  expect(rows[0].payload.item).toMatchObject({ encrypted_content: 'wrapped-affinity' });
  expect(await repo.responsesSnapshots.lookup('key-a', 'resp_public')).not.toBeNull();
});
