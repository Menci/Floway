import { expect, test } from 'vitest';

import { createMergeState, materializeHostedToolItems } from '../../../../../src/data-plane/chat/openai-responses/hosted-tools/shared.ts';
import type { HostedToolLifecycleEvent, HostedToolTerminal } from '../../../../../src/data-plane/chat/openai-responses/hosted-tools/types.ts';
import { mockChatGatewayCtx } from '../../../../test-utils/gateway-ctx.ts';

test('returning hosted materialization closes the active child lifecycle after its delivered partial frame', async () => {
  let closed = false;
  const frames = materializeHostedToolItems([{
    slots: [{
      intercepted: { callId: 'call', name: 'image_generation', arguments: { prompt: 'tree' } },
      outputIndex: 0,
      slot: {
        id: 'image', startItem: { type: 'image_generation_call', status: 'in_progress' }, startEvents: [],
        run: () => (async function* (): AsyncGenerator<HostedToolLifecycleEvent, HostedToolTerminal> {
          try {
            yield { type: 'response.image_generation_call.partial_image', partial_image_index: 0, partial_image_b64: 'preview' };
            throw new Error('a cancelled lifecycle must not request another event');
          } finally {
            closed = true;
          }
        })(),
      },
    }],
  }], createMergeState(), mockChatGatewayCtx().store);
  expect(await frames.next()).toMatchObject({ done: false, value: { type: 'event', event: { type: 'response.image_generation_call.partial_image', partial_image_b64: 'preview', item_id: 'image', output_index: 0 } } });
  expect(closed).toBe(false);
  await frames.return();
  expect(closed).toBe(true);
});
