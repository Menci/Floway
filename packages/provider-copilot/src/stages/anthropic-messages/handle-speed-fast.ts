import { copilotModelSupportsFastVariant } from '../../model-selection.ts';
import { copilotProviderData } from '../../routing.ts';
import { unchanged } from '../shared/stages.ts';
import { Bytes, defineStage } from '@floway-dev/pipeline';
import type { AnthropicMessagesStreamEventEx } from '@floway-dev/protocols/anthropic-messages';
import { eventFrame, type ProtocolFrame } from '@floway-dev/protocols/common';
import type { ProviderAnthropicInput, ProviderServices, ProviderStreamOutput } from '@floway-dev/provider';

type Output = ProviderStreamOutput<AnthropicMessagesStreamEventEx>;

// Anthropic rejects Fast Mode on unsupported models before dispatch.
// https://docs.claude.com/en/build-with-claude/fast-mode
// https://github.com/Yeachan-Heo/gajae-code/blob/main/packages/ai/test/anthropic-fast-mode.test.ts
export const requireFastMode = defineStage<ProviderAnthropicInput, ProviderAnthropicInput, Output, Output, ProviderServices>({
  name: 'require-fast-mode',
  through: {
    request: { ...unchanged, needs: ['provider.model', 'request.payload'] },
    response: unchanged,
  },
  return: { provides: ['response.http', 'response.modelKey', 'response.events'] },
  async execute(facts, next, env) {
    const model = facts['provider.model'];
    if (facts['request.payload'].speed !== 'fast' || copilotModelSupportsFastVariant(copilotProviderData(model).rawModels)) {
      return await next(facts);
    }

    const now = env.clock();
    return {
      'response.http': {
        status: 400,
        statusText: '',
        headers: [['content-type', 'application/json']],
        body: Bytes.fromUtf8(JSON.stringify({
          type: 'error',
          error: {
            type: 'invalid_request_error',
            message: `'${model.id}' does not support the \`speed\` parameter.`,
          },
        })),
        timing: { startedAt: now, headersAt: now },
      },
      'response.modelKey': model.id,
      'response.events': undefined,
    };
  },
});

const stampFastSpeed = async function* (frames: AsyncIterable<ProtocolFrame<AnthropicMessagesStreamEventEx>>) {
  for await (const frame of frames) {
    if (frame.type === 'event' && frame.event.type === 'message_start') {
      const { event } = frame;
      yield eventFrame({
        ...event,
        message: { ...event.message, usage: { ...event.message.usage, speed: 'fast' } },
      });
    } else {
      yield frame;
    }
  }
};

// Copilot selects Fast Mode through the raw model ID and omits usage.speed.
// https://docs.claude.com/en/api/service-tiers
export const handleSpeedFast = defineStage<ProviderAnthropicInput, ProviderAnthropicInput, Output, Output, ProviderServices>({
  name: 'handle-speed-fast',
  through: {
    request: { needs: ['request.payload'], consumes: [], provides: ['request.payload'] },
    response: { needs: ['response.events'], consumes: [], provides: ['response.events'] },
  },
  async execute(facts, next, env) {
    const { speed, ...withoutSpeed } = facts['request.payload'];
    const back = await next({
      ...facts,
      'request.payload': speed === 'fast' || speed === 'standard' ? withoutSpeed : facts['request.payload'],
    });
    const events = back['response.events'];
    if (speed !== 'fast' || events === undefined) return back;
    return { ...back, 'response.events': env.wrapStream(events, { label: 'anthropic.fast-mode', transform: stampFastSpeed }) };
  },
});
