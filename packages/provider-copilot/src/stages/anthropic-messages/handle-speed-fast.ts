import type { CopilotUpstreamFacts } from '../../config.ts';
import { copilotModelSupportsFastVariant } from '../../model-selection.ts';
import { copilotProviderData } from '../../routing.ts';
import { unchanged } from '../shared/stages.ts';
import { defineStage } from '@floway-dev/pipeline';
import type { AnthropicMessagesStreamEventEx } from '@floway-dev/protocols/anthropic-messages';
import { eventFrame } from '@floway-dev/protocols/common';
import type { ProviderAnthropicInput, ProviderAnthropicMessagesOutput, ProviderFrame } from '@floway-dev/provider';

type Input = ProviderAnthropicInput<CopilotUpstreamFacts>;
type Output = ProviderAnthropicMessagesOutput;

// Anthropic rejects Fast Mode on unsupported models before dispatch.
// https://docs.claude.com/en/build-with-claude/fast-mode
// https://github.com/Yeachan-Heo/gajae-code/blob/main/packages/ai/test/anthropic-fast-mode.test.ts
export const requireFastMode = defineStage<Input, Input, Output, Output>({
  name: 'require-fast-mode',
  through: {
    request: { ...unchanged, needs: ['provider.model', 'request.payload'] },
    response: unchanged,
  },
  return: { provides: ['response.http', 'response.modelKey', 'response.anthropicMessages'] },
  async execute(facts, scope) {
    const model = facts['provider.model'];
    if (facts['request.payload'].speed !== 'fast' || copilotModelSupportsFastVariant(copilotProviderData(model).rawModels)) {
      return await scope.next(facts);
    }

    const now = scope.clock();
    return {
      'response.http': {
        status: 400,
        statusText: '',
        headers: [['content-type', 'application/json']],
        body: null,
        timing: { startedAt: now, headersAt: now },
      },
      'response.modelKey': model.id,
      'response.anthropicMessages': {
        kind: 'error',
        source: 'local',
        error: {
          type: 'error',
          error: {
            type: 'invalid_request_error',
            message: `'${model.id}' does not support the \`speed\` parameter.`,
          },
        },
      },
    };
  },
});

const stampFastSpeed = async function* (frames: AsyncIterable<ProviderFrame<AnthropicMessagesStreamEventEx>>) {
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
export const handleSpeedFast = defineStage<Input, Input, Output, Output>({
  name: 'handle-speed-fast',
  through: {
    request: { needs: ['request.payload'], consumes: [], provides: ['request.payload'] },
    response: { needs: ['response.anthropicMessages'], consumes: [], provides: ['response.anthropicMessages'] },
  },
  async execute(facts, scope) {
    const { speed, ...withoutSpeed } = facts['request.payload'];
    const back = await scope.next({
      ...facts,
      'request.payload': speed === 'fast' || speed === 'standard' ? withoutSpeed : facts['request.payload'],
    });
    const outcome = back['response.anthropicMessages'];
    if (speed !== 'fast' || outcome.kind !== 'stream') return back;
    const events = scope.wrapStream(outcome.events, { label: 'anthropic.fast-mode', transform: stampFastSpeed });
    return { ...back, 'response.anthropicMessages': { ...outcome, events } };
  },
});
