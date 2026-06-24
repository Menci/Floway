import { test } from 'vitest';

import { withReasoningEncryptedContentCanonicalized } from './canonicalize-encrypted-content.ts';
import type { ResponsesInvocation } from './types.ts';
import type { GatewayCtx } from '../../shared/gateway-ctx.ts';
import { MemoryStatefulResponsesBacking, LayeredStatefulResponsesStore } from '../items/store.ts';
import { eventFrame, type ProtocolFrame } from '@floway-dev/protocols/common';
import type { ResponsesPayload, ResponsesStreamEvent } from '@floway-dev/protocols/responses';
import { type ExecuteResult, eventResult } from '@floway-dev/provider';
import { stubProviderCandidate, testTelemetryModelIdentity, assertEquals } from '@floway-dev/test-utils';

const stubCtx: GatewayCtx = {
  apiKeyId: 'test-key',
  upstreamIds: null,
  wantsStream: false,
  runtimeLocation: 'TEST',
  currentColo: 'TEST',
  dump: null,
  backgroundScheduler: () => {},
  requestStartedAt: 0,
};

const invocation = (): ResponsesInvocation => ({
  payload: { model: 'gpt-test', input: 'hi' } as ResponsesPayload,
  candidate: stubProviderCandidate({ targetApi: 'responses' }),
  store: new LayeredStatefulResponsesStore({
    apiKeyId: 'test-key',
    reads: [new MemoryStatefulResponsesBacking()],
    itemWrites: [],
    snapshotWrites: [],
    stageInputs: false,
  }),
  headers: new Headers(),
});

const result = (response: { status: 'completed'; output: unknown[] }) => (): Promise<ExecuteResult<ProtocolFrame<ResponsesStreamEvent>>> =>
  Promise.resolve(eventResult(
    (async function* () {
      yield eventFrame({ type: 'response.output_item.done' as const, output_index: 0, item: { type: 'reasoning' as const, id: 'rs_alpha', summary: [], encrypted_content: 'ENC_DONE' } });
      yield eventFrame({
        type: 'response.completed' as const,
        response: { id: 'resp_1', object: 'response' as const, model: 'gpt-test', status: response.status, output: response.output as never, output_text: '', error: null, incomplete_details: null },
      });
    })(),
    testTelemetryModelIdentity,
  ));

const collect = async (events: AsyncIterable<ProtocolFrame<ResponsesStreamEvent>>) => {
  const out: ResponsesStreamEvent[] = [];
  for await (const frame of events) if (frame.type === 'event') out.push(frame.event);
  return out;
};

test('rewrites response.completed encrypted_content to the output_item.done blob', async () => {
  const res = await withReasoningEncryptedContentCanonicalized(invocation(), stubCtx, result({
    status: 'completed',
    output: [
      { type: 'reasoning', id: 'rs_alpha', summary: [], encrypted_content: 'ENC_COMPLETED' },
      { type: 'reasoning', id: 'rs_beta', summary: [], encrypted_content: 'ENC_BETA_ONLY' },
    ],
  }));
  if (res.type !== 'events') throw new Error('expected events');

  const completed = (await collect(res.events)).find(event => event.type === 'response.completed');
  assertEquals(
    completed!.response.output.map(item => [item.id, (item as { encrypted_content?: string }).encrypted_content]),
    [['rs_alpha', 'ENC_DONE'], ['rs_beta', 'ENC_BETA_ONLY']],
  );
});
