import { geminiGenerateContentPayload, servesNativeGeminiGenerateContent } from './native-target.ts';
import { gatewayFactSpace } from '../../../pipeline/facts.ts';
import { move, transform } from '@floway-dev/pipeline';

const { defineStage } = gatewayFactSpace<{}>();
const key = 'request.geminiGenerateContent';

export const stripSafetySettings = defineStage({
  name: 'geminiGenerateContent.strip-safety-settings',
  through: {
    request: { needs: [key, 'serve.candidate'], provides: [key], consumes: [] },
    response: { needs: [], provides: [], consumes: [] },
  },
  execute: transform(() => ({
    request: facts => {
      if (servesNativeGeminiGenerateContent(facts['serve.candidate'])) return facts;
      const { safetySettings: _settings, ...payload } = geminiGenerateContentPayload(facts[key]);
      return { ...facts, [key]: move(payload) };
    },
  })),
});
