import type { Chat } from '../facts.ts';
import { withoutKeys } from '../shared/structural.ts';
import { defineStage, transform, move } from '@floway-dev/pipeline';

/** Gemini generateContent safety controls are source-specific and have no matching control on every target
 *  path, so they go rather than have us pretend to enforce a policy we cannot honor
 *  end to end. */
export const stripSafetySettingsFromGeminiGenerateContent = defineStage<
  Chat<'request.chat.geminiGenerateContent'>,
  Chat<'request.chat.geminiGenerateContent'>,
  Chat<'response.chat.geminiGenerateContent'>,
  Chat<'response.chat.geminiGenerateContent'>
>({
  name: 'stripSafetySettings',
  through: {
    request: { needs: ['request.chat.geminiGenerateContent'], consumes: [], provides: ['request.chat.geminiGenerateContent'] },
    response: { needs: ['response.chat.geminiGenerateContent'], consumes: [], provides: [] },
  },
  execute: transform<
    Chat<'request.chat.geminiGenerateContent'>,
    Chat<'request.chat.geminiGenerateContent'>,
    Chat<'response.chat.geminiGenerateContent'>,
    Chat<'response.chat.geminiGenerateContent'>
  >(() => ({
    request: facts => {
      const payload = facts['request.chat.geminiGenerateContent'];
      const stripped = withoutKeys(payload, ['safetySettings']);
      return stripped === payload ? facts : { ...facts, 'request.chat.geminiGenerateContent': move(stripped) };
    },
  })),
});
