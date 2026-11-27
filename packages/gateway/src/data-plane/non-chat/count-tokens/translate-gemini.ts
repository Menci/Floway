import { supportsNativeGeminiGenerateContentCountTokens } from './candidates.ts';
import { defineStage } from './facts.ts';
import { gatewayErrorStatus, geminiGenerateContentRpcErrorPayload } from '../../chat/gemini-generate-content/errors.ts';
import { stripUnsupportedPartFieldsFromPayload } from '../../chat/gemini-generate-content/pipeline/unsupported-part-fields.ts';
import { stripUnsupportedToolsFromPayload } from '../../chat/gemini-generate-content/pipeline/unsupported-tools.ts';
import { SidecarDomain } from '../../chat/shared/sidecar-codec.ts';
import { localHead } from '../shared/http.ts';
import { deleteHeader } from '@floway-dev/http';
import type { GeminiGenerateContentPayload } from '@floway-dev/protocols/gemini-generate-content';
import { routeGeminiGenerateContentViaAnthropicMessages } from '@floway-dev/translate';
import type { ProtocolError } from '@floway-dev/upstream';

const request = ['http', 'upstream', 'model', 'aliasRules', 'geminiGenerateContentCountTokens'] as const;
const response = ['http', 'geminiGenerateContentCountTokens'] as const;

export const routeGeminiGenerateContentCountTokens = defineStage({
  name: 'geminiGenerateContentCountTokens.translate',
  request: { needs: request },
  return: { provides: response },
  into: {
    geminiGenerateContent: {
      request: { needs: request, provides: [], consumes: [] },
      response: { needs: [...response, 'usage'], provides: [], consumes: [] },
    },
    anthropicMessages: {
      request: {
        needs: request,
        provides: ['http', 'anthropicMessagesCountTokens'],
        consumes: ['geminiGenerateContentCountTokens'],
      },
      response: {
        needs: ['http', 'anthropicMessagesCountTokens', 'usage?'],
        provides: response,
        consumes: ['anthropicMessagesCountTokens'],
      },
    },
  },
  async execute(facts, scope) {
    const { model, upstream } = facts;
    if (supportsNativeGeminiGenerateContentCountTokens({ model, upstream })) {
      return await scope.into.geminiGenerateContent(facts);
    }

    const { geminiGenerateContentCountTokens: { generateContentRequest, contents }, http, ...other } = facts;
    const generation: GeminiGenerateContentPayload = generateContentRequest ?? { contents: contents ?? [] };
    const { safetySettings: _safetySettings, ...payload } = generation;
    const clean = stripUnsupportedPartFieldsFromPayload(stripUnsupportedToolsFromPayload(payload));
    const trip = await routeGeminiGenerateContentViaAnthropicMessages({ ...clean, model: model.id }, {
      sidecarCodec: scope.services.sidecarCodec.codecFor(SidecarDomain.TranslatedAssistantTurn),
      fallbackMaxOutputTokens: model.limits.max_output_tokens,
    });
    if (trip.type === 'input-error') {
      return {
        http: localHead(400),
        geminiGenerateContentCountTokens: { kind: 'error', source: 'local', error: geminiGenerateContentRpcErrorPayload(400, trip.message) },
      };
    }
    const { max_tokens: _maxTokens, stream: _stream, ...anthropicMessagesCountTokens } = trip.target;
    const { anthropicMessagesCountTokens: outcome, ...answer } = await scope.into.anthropicMessages({
      ...other,
      http: { ...http, headers: deleteHeader(http.headers, 'anthropic-beta') },
      anthropicMessagesCountTokens,
    });
    if (outcome.kind === 'error') {
      const { source } = outcome;
      if (answer.http === null && source === 'local') {
        return {
          ...answer, geminiGenerateContentCountTokens: {
            kind: 'error', source, error: { error: { code: 499, status: 'CANCELLED', message: JSON.stringify(outcome.error) } },
          },
        };
      }
      const head = answer.http;
      const status = head === null || (head.status >= 200 && head.status < 300) ? 502 : head.status;
      const code = gatewayErrorStatus(status) === 'INTERNAL' ? 500 : status;
      const message = JSON.stringify(outcome.error);
      const mapped: ProtocolError = { kind: 'error', source, error: geminiGenerateContentRpcErrorPayload(code, message) };
      const dump = scope.services.dump;
      if (dump !== null && head !== null && source === 'upstream') {
        dump.stageUpstreamTranslationError(mapped, () => {
          const headers = new Headers();
          for (const [name, value] of head.headers) {
            if (typeof value !== 'string') throw new TypeError(`Secret response header ${name} crossed the upstream boundary`);
            headers.append(name, value);
          }
          dump.setUpstreamTargetApi('anthropicMessages');
          dump.upstreamApiError({ status: head.status, headers, body: new TextEncoder().encode(message) });
        });
      }
      return {
        ...answer,
        http: head === null || head.status === code ? head : { ...head, status: code, statusText: '' },
        geminiGenerateContentCountTokens: mapped,
      };
    }
    const result = outcome.result === null ? null : { totalTokens: outcome.result.input_tokens };
    return { ...answer, geminiGenerateContentCountTokens: { kind: 'result', result } };
  },
});
