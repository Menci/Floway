import { openAIResponsesExit, openAIResponsesFactSpace } from './facts.ts';
import { readProtocolFrames } from '../../pipeline/protocol-frames.ts';
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
    const stream = scope.wrapStream(outcome.stream, async function* (items, producer) {
      const source = readProtocolFrames(items);
      let failure;
      try {
        for await (const frame of serializeOpenAIResponsesStream(source.frames(), true)) {
          if (frame.type === 'event') yield { ok: true, value: frame.event };
        }
      } catch (cause) {
        failure = cause === source.failure ? source.failure : { kind: 'protocol' as const, cause };
      }
      if (!source.done) producer.abort(call);
      if (failure !== undefined) yield { ok: false, error: failure };
      await source.drain();
    });
    return { ...back, 'response.openaiResponses': move({ kind: 'stream', stream } as const) };
  },
});
