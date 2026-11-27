import { selectCountTokensCandidates, supportsAnthropicMessagesCountTokens, supportsNativeGeminiGenerateContentCountTokens } from './candidates.ts';
import { defineStage } from './facts.ts';
import { analyzeGeminiGenerateContentAffinity } from '../../chat/gemini-generate-content/affinity/ingress.ts';
import { geminiGenerateContentRpcErrorPayload } from '../../chat/gemini-generate-content/errors.ts';
import { discoverCandidates } from '../../pipeline/discover-candidates.ts';
import { localHead } from '../shared/http.ts';
import { unavailableModel } from '../shared/routing.ts';

export const discoverGeminiGenerateContentCountTokensCandidates = defineStage({
  name: 'geminiGenerateContentCountTokens.discover-candidates',
  through: {
    request: {
      needs: ['geminiGenerateContentCountTokens', 'requestedModel'],
      provides: ['geminiGenerateContentCountTokensTargets'],
      consumes: ['geminiGenerateContentCountTokens', 'requestedModel'],
    },
    response: { needs: [], provides: [], consumes: [] },
  },
  return: { provides: ['http', 'geminiGenerateContentCountTokens'] },
  async execute({ geminiGenerateContentCountTokens: payload, requestedModel, ...facts }, scope) {
    const failed = (status: 400 | 404, message: string) => ({
      http: localHead(status),
      geminiGenerateContentCountTokens: { kind: 'error' as const, source: 'local' as const, error: geminiGenerateContentRpcErrorPayload(status, message) },
    });
    const { candidates, exists } = await discoverCandidates(scope.services, {
      kind: 'chat', model: requestedModel, payload,
      supports: candidate => supportsNativeGeminiGenerateContentCountTokens(candidate) || supportsAnthropicMessagesCountTokens(candidate),
    });
    const { generateContentRequest, contents } = payload;
    const affinity = await analyzeGeminiGenerateContentAffinity(generateContentRequest ?? { contents: contents ?? [] }, scope.services.affinity);
    const selection = selectCountTokensCandidates(candidates, affinity);
    if ('kind' in selection) return failed(400, selection.message);
    if (selection.length === 0) {
      return failed(exists ? 400 : 404, exists
        ? `Model ${requestedModel} does not support countTokens.`
        : unavailableModel(requestedModel, 'countTokens', false));
    }
    const targets = selection.map(({ payload: projected, ...candidate }) => ({
      ...candidate, payload: generateContentRequest === undefined
        ? { contents: projected.contents ?? [] }
        : { generateContentRequest: { ...generateContentRequest, ...projected } },
    }));
    return await scope.next({ ...facts, geminiGenerateContentCountTokensTargets: targets });
  },
});
