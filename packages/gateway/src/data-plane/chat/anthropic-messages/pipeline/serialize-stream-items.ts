import { transformAnthropicMessagesFrames } from './protocol-stream.ts';
import { gatewayFactSpace } from '../../../pipeline/facts.ts';
import { serializeAnthropicMessagesStream, shouldSerializeStreamItems } from '../../shared/stream-compatibility/index.ts';
import { getHeader } from '@floway-dev/http';
import { move, transform } from '@floway-dev/pipeline';

const { defineStage } = gatewayFactSpace<{}>();
const responseKey = 'response.anthropicMessages';

export const serializeStreamItems = defineStage({
  name: 'anthropicMessages.serialize-stream-items',
  through: {
    request: { needs: ['request.http', 'serve.candidate'], provides: [], consumes: [] },
    response: { needs: [responseKey], provides: [responseKey], consumes: [] },
  },
  execute: transform(scope => {
    let enabled: boolean;
    return {
      request: facts => {
        const agent = getHeader(facts['request.http'].headers, 'user-agent');
        enabled = shouldSerializeStreamItems(new Set(facts['serve.candidate'].model.enabledFlags), 'anthropicMessages', typeof agent === 'string' ? agent : null);
        return facts;
      },
      response: facts => {
        const outcome = facts[responseKey];
        if (!enabled || outcome.kind !== 'stream') return facts;
        const stream = scope.wrapStream(outcome.stream, (items, producer) =>
          transformAnthropicMessagesFrames(items, frames => serializeAnthropicMessagesStream(frames, true),
            () => { producer.abort(facts); }));
        return { ...facts, [responseKey]: move({ kind: 'stream', stream } as const) };
      },
    };
  }),
});
