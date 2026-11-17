import type { GeminiGenerateContentInterceptor } from './types.ts';

/**
 * A translated target has no matching safety control, so forwarding the
 * settings would pretend to enforce a policy the gateway cannot honour
 * end-to-end. A native Gemini upstream enforces them itself and receives them
 * unchanged.
 */
export const stripSafetySettings: GeminiGenerateContentInterceptor = (ctx, _gatewayCtx, run) => {
  if (ctx.targetApi !== 'geminiGenerateContent') delete ctx.payload.safetySettings;
  return run();
};
