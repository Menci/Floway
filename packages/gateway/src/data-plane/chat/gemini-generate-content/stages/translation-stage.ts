import { defineStage } from '../../../pipeline/facts.ts';
import type { GeminiGenerateContentPayload } from '@floway-dev/protocols/gemini-generate-content';

export const geminiTranslationStage = (
  name: string,
  shape: (payload: GeminiGenerateContentPayload) => GeminiGenerateContentPayload,
) => defineStage({
  name: `geminiGenerateContent.${name}`,
  through: {
    request: { needs: ['request.geminiGenerateContent', 'provider.model'], provides: ['request.geminiGenerateContent'], consumes: [] },
    response: { needs: [], provides: [], consumes: [] },
  },
  execute: async (facts, scope) => await scope.next({
    ...facts,
    'request.geminiGenerateContent': facts['provider.model'].endpoints.geminiGenerateContent === undefined
      ? shape(facts['request.geminiGenerateContent'])
      : facts['request.geminiGenerateContent'],
  }),
});
