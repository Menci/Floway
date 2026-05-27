import { test } from 'vitest';

import { withVisionHeaderSet } from './set-vision-header.ts';
import { assertEquals } from '../../../../../test-assert.ts';
import { stubProvider, stubUpstreamModel, testTelemetryModelIdentity } from '../../../../../test-helpers.ts';
import type { RequestContext, ResponsesInvocation } from '../../../../llm/interceptors.ts';
import { eventResult, type ExecuteResult } from '../../../../llm/shared/errors/result.ts';
import type { ProtocolFrame } from '@floway-dev/protocols/common';
import type { ResponseInputItem, ResponsesPayload, ResponsesStreamEvent } from '@floway-dev/protocols/responses';

const stubRequest: RequestContext = {
  requestStartedAt: 0,
  runtimeLocation: 'test',
  clientStream: false,
};

const okEvents = (): Promise<ExecuteResult<ProtocolFrame<ResponsesStreamEvent>>> =>
  Promise.resolve(eventResult((async function* (): AsyncGenerator<ProtocolFrame<ResponsesStreamEvent>> {})(), testTelemetryModelIdentity));

const invocation = (payload: ResponsesPayload): ResponsesInvocation => ({
  sourceApi: 'responses',
  targetApi: 'responses',
  model: payload.model,
  upstream: 'test-upstream',
  payload,
  provider: stubProvider(),
  upstreamModel: stubUpstreamModel(),
  enabledFlags: new Set<string>(),
  headers: {},
});

test('Responses vision header set when an input_image block is present on a top-level message', async () => {
  const ctx = invocation({
    model: 'gpt-test',
    input: [
      {
        type: 'message',
        role: 'user',
        content: [
          { type: 'input_text', text: 'look at this' },
          { type: 'input_image', image_url: 'data:image/png;base64,AAAA', detail: 'auto' },
        ],
      },
    ],
  });

  await withVisionHeaderSet(ctx, stubRequest, okEvents);

  assertEquals(ctx.headers['copilot-vision-request'], 'true');
});

test('Responses vision header set when an input_image is nested inside a non-message item', async () => {
  // Recursive scan: hosted-tool outputs (and other future input shapes) may
  // carry image content under `content`, not at the top-level message layer.
  const ctx = invocation({
    model: 'gpt-test',
    input: [
      {
        type: 'message',
        role: 'user',
        content: [{ type: 'input_text', text: 'analyze' }],
      },
      {
        type: 'custom_tool_call_output',
        call_id: 'call_1',
        // Real hosted-tool outputs do not currently carry images, but the
        // shim path can stuff arbitrary content blocks here, and caozhiyuan's
        // detector treats any nested `input_image` as vision input.
        content: [{ type: 'input_image', image_url: 'data:image/png;base64,BBBB' }],
      } as unknown as ResponseInputItem,
    ],
  });

  await withVisionHeaderSet(ctx, stubRequest, okEvents);

  assertEquals(ctx.headers['copilot-vision-request'], 'true');
});

test('Responses vision header absent when content is pure text', async () => {
  const ctx = invocation({
    model: 'gpt-test',
    input: [
      {
        type: 'message',
        role: 'user',
        content: [{ type: 'input_text', text: 'plain text only' }],
      },
    ],
  });

  await withVisionHeaderSet(ctx, stubRequest, okEvents);

  assertEquals('copilot-vision-request' in ctx.headers, false);
});

test('Responses vision header absent when input is a plain string', async () => {
  const ctx = invocation({
    model: 'gpt-test',
    input: 'plain string input',
  });

  await withVisionHeaderSet(ctx, stubRequest, okEvents);

  assertEquals('copilot-vision-request' in ctx.headers, false);
});
