import { defineStage } from './facts.ts';
import { observeUsage } from '../../pipeline/compute-usage.ts';

export const computeGeminiGenerateContentCountTokensUsage = defineStage({
  name: 'geminiGenerateContentCountTokens.compute-usage',
  through: {
    request: { needs: [], provides: [], consumes: [] },
    response: { needs: ['geminiGenerateContentCountTokens', 'usageModelKey?'], provides: ['usage'], consumes: ['usageModelKey'] },
  },
  async execute(facts, scope) {
    const { geminiGenerateContentCountTokens: outcome, usageModelKey: _usageModelKey, ...answer } = await scope.next(facts);
    const { usage } = observeUsage(scope, outcome, '', { result: () => [] });
    return { ...answer, geminiGenerateContentCountTokens: outcome, usage };
  },
});
