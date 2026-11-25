import { geminiTranslationStage } from './translation-stage.ts';
import type { GeminiGenerateContentPayload } from '@floway-dev/protocols/gemini-generate-content';

/**
 * A translated target has no matching safety control, so forwarding the
 * settings would pretend to enforce a policy the gateway cannot honour
 * end-to-end. A native Gemini upstream enforces them itself and receives them
 * unchanged.
 */
export const stripSafetySettingsFromPayload = (payload: GeminiGenerateContentPayload): GeminiGenerateContentPayload => {
  const { safetySettings: _safetySettings, ...rest } = payload;
  return rest;
};

export const stripSafetySettings = geminiTranslationStage('strip-safety-settings', stripSafetySettingsFromPayload);
