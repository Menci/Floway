import { defineCopilotStage } from '../facts.ts';

const copilotOpenAIEmbeddingsBody = <Body extends Record<string, unknown>>(body: Body): Body => {
  if (typeof body.input !== 'string') return body;

  // OpenAI-compatible clients may send scalar string input, but Copilot's
  // upstream /embeddings endpoint currently returns 400 unless text input is
  // wrapped as an array.
  // References:
  // https://platform.openai.com/docs/api-reference/embeddings/create
  // https://github.com/ericc-ch/copilot-api/blob/0ea08febdd7e3e055b03dd298bf57e669500b5c1/src/services/copilot/create-embeddings.ts#L19-L21
  // https://github.com/BerriAI/litellm/blob/c8fb77f119ad69a80f5fde088efd3a1aa77f458b/litellm/proxy/proxy_server.py#L7826-L7839
  return { ...body, input: [body.input] };
};

export const wrapScalarInput = defineCopilotStage({
  name: 'copilot.openaiEmbeddings.wrapScalarInput',
  through: {
    request: { needs: ['openaiEmbeddings'], provides: ['openaiEmbeddings'], consumes: [] },
    response: { needs: [], provides: [], consumes: [] },
  },
  async execute(facts, scope) {
    const payload = copilotOpenAIEmbeddingsBody(facts.openaiEmbeddings);
    return await scope.next(payload === facts.openaiEmbeddings ? facts : { ...facts, openaiEmbeddings: payload });
  },
});
