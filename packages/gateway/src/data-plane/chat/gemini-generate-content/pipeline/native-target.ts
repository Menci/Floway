import type { ServeCandidate } from '../../../pipeline/facts.ts';
import { providerSupportsOperation } from '../../../pipeline/provider-pipelines.ts';
import type { GeminiGenerateContentPayload } from '@floway-dev/protocols/gemini-generate-content';
import type { GatewayFacts } from '@floway-dev/provider';

export const servesNativeGeminiGenerateContent = (
  { model, upstream }: ServeCandidate,
  operation: 'geminiGenerateContent' | 'geminiGenerateContentCountTokens' = 'geminiGenerateContent',
): boolean => model.endpoints.geminiGenerateContent !== undefined && providerSupportsOperation(upstream.kind, operation);

export const geminiGenerateContentPayload = (payload: GatewayFacts['request.geminiGenerateContent']): GeminiGenerateContentPayload => {
  if (!Array.isArray(payload.contents)) throw new TypeError('Expected Gemini generateContent contents');
  return payload as GeminiGenerateContentPayload;
};
