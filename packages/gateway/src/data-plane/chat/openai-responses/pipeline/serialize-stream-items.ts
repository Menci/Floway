import { openAIResponsesExit, openAIResponsesFactSpace } from './facts.ts';
import { transformProtocolFrames } from '../../pipeline/protocol-frames.ts';
import { serializeOpenAIResponsesStream } from '../../shared/stream-compatibility/index.ts';
import { move } from '@floway-dev/pipeline';

const { defineStage } = openAIResponsesFactSpace<{}>();

export const serializeOpenAIResponsesStreamItems = defineStage({
  name: 'openaiResponses.serialize-stream-items',
  through: {
    request: { needs: ['serve.candidate'], provides: [], consumes: [] },
    response: { needs: openAIResponsesExit, provides: ['response.openaiResponses'], consumes: [] },
  },
  async execute(facts, scope) {
    const call = scope.next(facts);
    const back = await call;
    const outcome = back['response.openaiResponses'];
    if (outcome.kind !== 'stream' || !facts['serve.candidate'].model.enabledFlags.includes('serialize-stream-items')) return back;
    const stream = scope.wrapStream(outcome.stream, (items, producer) =>
      transformProtocolFrames(items, frames => serializeOpenAIResponsesStream(frames, true), () => { producer.abort(call); }));
    return { ...back, 'response.openaiResponses': move({ kind: 'stream', stream } as const) };
  },
});
