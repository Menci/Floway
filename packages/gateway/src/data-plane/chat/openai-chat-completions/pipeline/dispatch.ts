import { defineStage } from '../../pipeline/facts.ts';

const provider = {
  request: { needs: ['http', 'upstream', 'model', 'openaiChatCompletions'], provides: [], consumes: [] },
  response: { needs: ['http', 'openaiChatCompletions', 'usageModelKey?'], provides: [], consumes: [] },
} as const;

export const dispatchOpenAIChatCompletions = defineStage({
  name: 'openaiChatCompletions.dispatch',
  request: { needs: provider.request.needs },
  into: {
    azure: provider,
    copilot: provider,
    custom: provider,
    'kimi-code': provider,
    ollama: provider,
  },
  async execute(facts, scope) {
    switch (facts.upstream.kind) {
    case 'azure': return await scope.into.azure(facts);
    case 'copilot': return await scope.into.copilot(facts);
    case 'custom': return await scope.into.custom(facts);
    case 'kimi-code': return await scope.into['kimi-code'](facts);
    case 'ollama': return await scope.into.ollama(facts);
    default: throw new Error(`Upstream ${facts.upstream.kind} has no openaiChatCompletions pipeline`);
    }
  },
});
