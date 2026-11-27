import { defineStage } from '../../pipeline/facts.ts';

export const stripGeminiGenerateContentSafetySettings = defineStage({
  name: 'geminiGenerateContent.strip-safety-settings',
  through: {
    request: { needs: ['geminiGenerateContent', 'chat.target'], provides: ['geminiGenerateContent'], consumes: [] },
    response: { needs: [], provides: [], consumes: [] },
  },
  async execute(facts, scope) {
    if (facts['chat.target'] === 'geminiGenerateContent') return await scope.next(facts);
    const { safetySettings: _safetySettings, ...payload } = facts.geminiGenerateContent;
    return await scope.next({ ...facts, geminiGenerateContent: payload });
  },
});
