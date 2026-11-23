import { rewriteChatRequest } from '../../shared/rewrite-stage.ts';
import type { GeminiGenerateContentRequest } from '@floway-dev/protocols/gemini-generate-content';

export const stripSafetySettings = rewriteChatRequest(
  'stripSafetySettings', 'request.geminiGenerateContent', (payload: GeminiGenerateContentRequest, _candidate, targetApi) => {
    if (targetApi === 'geminiGenerateContent') return payload;
    const { safetySettings: _removed, ...rest } = payload;
    return rest;
  },
);
