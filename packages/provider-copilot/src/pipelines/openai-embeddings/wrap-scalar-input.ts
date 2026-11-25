import { defineCopilotStage } from '../facts.ts';
import { move, transform } from '@floway-dev/pipeline';

// Copilot's /embeddings endpoint requires an array for text input.
// https://github.com/ericc-ch/copilot-api/blob/0ea08febdd7e3e055b03dd298bf57e669500b5c1/src/services/copilot/create-embeddings.ts#L19-L21
export const wrapScalarInput = defineCopilotStage({
  name: 'copilot.openaiEmbeddings.wrapScalarInput',
  through: {
    request: { needs: ['request.openaiEmbeddings'], provides: ['request.openaiEmbeddings'], consumes: [] },
    response: { needs: [], provides: [], consumes: [] },
  },
  execute: transform(() => ({
    request(facts) {
      const payload = facts['request.openaiEmbeddings'];
      if (typeof payload.input !== 'string') return facts;
      const next = { ...payload, input: [payload.input] };
      return { ...facts, 'request.openaiEmbeddings': move(next) };
    },
  })),
});
