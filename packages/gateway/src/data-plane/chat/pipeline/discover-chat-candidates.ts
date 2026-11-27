import { defineStage } from './facts.ts';

export const discoverChatCandidates = defineStage({
  name: 'chat.discover-candidates',
  through: {
    request: { needs: ['requestedModel'], provides: ['candidates', 'chat.modelExists'], consumes: [] },
    response: { needs: [], provides: [], consumes: [] },
  },
  async execute(facts, scope) {
    const { candidates, sawModel } = await scope.services.catalogCandidates({ model: facts.requestedModel, kind: 'chat' });
    return await scope.next({ ...facts, candidates, 'chat.modelExists': sawModel });
  },
});
