import { test } from 'vitest';

import { withReasoningEncryptedContentCanonicalized } from './canonicalize-encrypted-content.ts';
import { assertEquals } from '../../../../../test-assert.ts';
import { stubProvider, stubUpstreamModel, testTelemetryModelIdentity } from '../../../../../test-helpers.ts';
import type { RequestContext, ResponsesInvocation } from '../../../interceptors.ts';
import { eventResult, type ExecuteResult } from '../../../shared/errors/result.ts';
import { eventFrame, type ProtocolFrame } from '@floway-dev/protocols/common';
import type { ResponsesPayload, RawResponsesStreamEvent } from '@floway-dev/protocols/responses';

const stubRequest: RequestContext = {
  requestStartedAt: 0,
  statefulResponsesContext: { privatePayload: new Map(), newSyntheticIds: new Set() },  runtimeLocation: 'test',
  clientStream: false,
};

const invocation = (): ResponsesInvocation => ({
  sourceApi: 'responses',
  targetApi: 'responses',
  model: 'gpt-test',
  upstream: 'test-upstream',
  payload: { model: 'gpt-test', input: 'hi' } as ResponsesPayload,
  provider: stubProvider(),
  upstreamModel: stubUpstreamModel(),
  enabledFlags: new Set<string>(),
  headers: {},
});

const result = (response: { status: 'completed'; output: unknown[] }) => (): Promise<ExecuteResult<ProtocolFrame<RawResponsesStreamEvent>>> =>
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

const collect = async (events: AsyncIterable<ProtocolFrame<RawResponsesStreamEvent>>) => {
  const out: RawResponsesStreamEvent[] = [];
  for await (const frame of events) if (frame.type === 'event') out.push(frame.event);
  return out;
};

test('rewrites response.completed encrypted_content to the output_item.done blob', async () => {
  const res = await withReasoningEncryptedContentCanonicalized(invocation(), stubRequest, result({
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
