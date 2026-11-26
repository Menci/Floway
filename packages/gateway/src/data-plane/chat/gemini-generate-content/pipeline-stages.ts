import { wrapGeminiGenerateContentAffinityEgress } from './affinity/egress.ts';
import { analyzeGeminiGenerateContentAffinity } from './affinity/ingress.ts';
import { collectGeminiGenerateContent, collectGeminiGenerateContentStreamError, encodeGeminiGenerateContent } from './encode.ts';
import { geminiGenerateContentLocalError } from './errors.ts';
import { parseGeminiGenerateContent, type GeminiGenerateContentDelivery } from './parse.ts';
import { stripSafetySettings } from './stages/strip-safety-settings.ts';
import { stripUnsupportedPartFields } from './stages/strip-unsupported-part-fields.ts';
import { stripUnsupportedTools } from './stages/strip-unsupported-tools.ts';
import { suppressThoughtParts } from './stages/suppress-thought-parts.ts';
import { defineStage } from '../../pipeline/facts.ts';
import { appendFailedUpstreams } from '../../shared/failed-upstreams.ts';
import { applyRulesToUpstreamGeminiGenerateContent } from '../shared/alias-rules.ts';
import { inputErrorFields } from '../shared/errors.ts';
import type { ChatProtocolStages } from '../shared/pipeline.ts';
import { chatTokenUsage } from '../shared/usage.ts';
import { billableUsageFromGeminiGenerateContentEvent } from '@floway-dev/protocols/gemini-generate-content';

const applyAliasRules = defineStage({
  name: 'geminiGenerateContent.apply-alias-rules',
  through: {
    request: { needs: ['request.geminiGenerateContent', 'request.aliasRules?'], provides: ['request.geminiGenerateContent'], consumes: [] },
    response: { needs: [], provides: [], consumes: [] },
  },
  async execute(facts, scope) {
    const rules = facts['request.aliasRules'];
    if (rules === undefined) return await scope.next(facts);
    const payload = { ...facts['request.geminiGenerateContent'] };
    applyRulesToUpstreamGeminiGenerateContent(payload, rules);
    return await scope.next({ ...facts, 'request.geminiGenerateContent': payload });
  },
});

export const geminiGenerateContentChat: ChatProtocolStages<'geminiGenerateContent', GeminiGenerateContentDelivery> = {
  parse: parseGeminiGenerateContent,
  encode: encodeGeminiGenerateContent,
  body: [stripUnsupportedPartFields, stripUnsupportedTools, stripSafetySettings, suppressThoughtParts],
  egress: [applyAliasRules],
  collect: collectGeminiGenerateContent,
  streamError: collectGeminiGenerateContentStreamError,
  usage: chatTokenUsage(() => billableUsageFromGeminiGenerateContentEvent, () => false),
  model: 'request.model',
  unavailable({ model, exists, failedUpstreams }) {
    const message = exists
      ? `Model ${model} does not support the Gemini generateContent endpoint.`
      : `Model ${model} is not available on any configured upstream.`;
    return geminiGenerateContentLocalError(exists ? 400 : 404, appendFailedUpstreams(message, failedUpstreams));
  },
  affinityUnavailable: message => geminiGenerateContentLocalError(400, message),
  invalidTranslation: error => geminiGenerateContentLocalError(400, error.message, inputErrorFields(error)),
  analyzeAffinity: analyzeGeminiGenerateContentAffinity,
  affinityEgress: wrapGeminiGenerateContentAffinityEgress,
};
