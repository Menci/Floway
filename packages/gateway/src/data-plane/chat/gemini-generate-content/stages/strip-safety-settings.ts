import type { ChatPipelineServices, GeminiGenerateContentAttemptInput } from '../../pipeline/index.ts';
import { defineRequestStage } from '@floway-dev/pipeline';
import type { ChatTargetApi } from '@floway-dev/provider';

interface Facts extends GeminiGenerateContentAttemptInput {
  readonly 'route.targetApi': ChatTargetApi;
}

// A translated target has no matching safety control, while a native Gemini
// upstream enforces the client's settings itself.
export const stripSafetySettings = defineRequestStage<
  Facts,
  Pick<Facts, 'request.payload'>,
  never,
  ChatPipelineServices
>({
  name: 'stripSafetySettings',
  provides: ['request.payload'],
  execute: async (facts, next) => {
    if (facts['route.targetApi'] === 'geminiGenerateContent') {
      return await next({ 'request.payload': facts['request.payload'] });
    }
    const { safetySettings: _safetySettings, ...payload } = facts['request.payload'];
    return await next({ 'request.payload': payload });
  },
});
