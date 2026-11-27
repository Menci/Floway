import { defineStage } from '../../pipeline/facts.ts';

const provider = {
  request: { needs: ['http', 'upstream', 'model', 'geminiGenerateContent'], provides: [], consumes: [] },
  response: { needs: ['http', 'geminiGenerateContent', 'usageModelKey?'], provides: [], consumes: [] },
} as const;

export const dispatchGeminiGenerateContent = defineStage({
  name: 'geminiGenerateContent.dispatch',
  request: { needs: provider.request.needs },
  into: {
    custom: provider,
  },
  async execute(facts, scope) {
    switch (facts.upstream.kind) {
    case 'custom': return await scope.into.custom(facts);
    default: throw new Error(`Upstream ${facts.upstream.kind} has no geminiGenerateContent pipeline`);
    }
  },
});
