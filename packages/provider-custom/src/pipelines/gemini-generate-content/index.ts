import { customGeminiModelActionPath } from '../../endpoint.ts';
import { customOperation, geminiGenerateContentError, jsonBody } from '../dial.ts';
import { decodeGeminiGenerateContentCountTokensResult, decodeGeminiGenerateContentStream, type GeminiCountTokensPayload } from '@floway-dev/protocols/gemini-generate-content';
import { parseJsonBody, parseResultResponse, parseSseResponse } from '@floway-dev/provider';

// A catalog name can include the models/ prefix, while the path takes the bare ID.
// https://ai.google.dev/api/generate-content#method:-models.streamgeneratecontent
const bareModelId = (id: string) => id.replace(/^models\//, '');

export const geminiGenerateContent = customOperation('geminiGenerateContent', {
  auth: 'x-goog-api-key',
  selectModelId: bareModelId,
  parse: parseSseResponse('geminiGenerateContent', decodeGeminiGenerateContentStream, geminiGenerateContentError),
  prepare: (payload, modelId, config) => ({
    path: customGeminiModelActionPath(config, modelId, 'streamGenerateContent'),
    ...jsonBody(payload),
  }),
});

// The full request counts system instructions, tools, and generation configuration.
// https://ai.google.dev/api/tokens#method:-models.counttokens
const countTokensBody = ({ contents, generateContentRequest }: GeminiCountTokensPayload, modelId: string): GeminiCountTokensPayload => {
  const model = `models/${modelId}`;
  if (generateContentRequest !== undefined) return { generateContentRequest: { ...generateContentRequest, model } };
  if (contents === undefined) throw new Error('Gemini countTokens requires contents or generateContentRequest');
  return { generateContentRequest: { contents, model } };
};

export const geminiGenerateContentCountTokens = customOperation('geminiGenerateContentCountTokens', {
  auth: 'x-goog-api-key',
  selectModelId: bareModelId,
  parse: parseResultResponse('geminiGenerateContentCountTokens', bytes => {
    const parsed = parseJsonBody(bytes);
    return parsed.ok ? decodeGeminiGenerateContentCountTokensResult(parsed.value) : parsed;
  }, geminiGenerateContentError),
  prepare: (payload, modelId, config) => ({
    path: customGeminiModelActionPath(config, modelId, 'countTokens'),
    ...jsonBody(countTokensBody(payload, modelId)),
  }),
});
