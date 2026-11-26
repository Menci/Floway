import type { ChatGPTUpstream } from '../config.ts';
import { CHATGPT_ALPHA_SEARCH_PATH, CHATGPT_OPENAI_IMAGES_EDITS_PATH, CHATGPT_OPENAI_IMAGES_GENERATIONS_PATH } from '../constants.ts';
import { uuidV7 } from '../ids.ts';
import { chatgptModelUsesResponsesLite } from '../models.ts';
import type { ChatGPTServices } from '../service.ts';
import { dialAlphaSearch, dialOpenAIImagesEdits, dialOpenAIImagesGenerations, dialOpenAIResponses, dialOpenAIResponsesCompact } from './dial.ts';
import { chatgptFactSpace } from './facts.ts';
import { injectOpenAIResponsesCompactDefaultInstructions, injectOpenAIResponsesDefaultInstructions } from './openai-responses/inject-default-instructions.ts';
import { codexResponsesRequest } from './openai-responses/request.ts';
import { openaiResponsesCompactLite } from './openai-responses/responses-compact-lite.ts';
import { openaiResponsesLite } from './openai-responses/responses-lite.ts';
import { normalizeOpenAIResponsesOutput } from './openai-responses/responses-output.ts';
import { stripOpenAIResponsesCompactUnsupportedFields, stripOpenAIResponsesUnsupportedFields } from './openai-responses/strip-unsupported-fields.ts';
import { normalizeDeepSeek } from './openai-responses/vendor-deepseek-normalize.ts';
import { normalizeQwen } from './openai-responses/vendor-qwen-normalize.ts';
import { chatgptJsonRequest, chatgptRequest, stringField, trimHeader } from './requests.ts';
import type { HttpHeaders } from '@floway-dev/http';
import { isJsonObject } from '@floway-dev/protocols/common';
import { decodeOpenAIImagesEditsStream, decodeOpenAIImagesGenerationsStream } from '@floway-dev/protocols/openai-images';
import { decodeOpenAIResponsesStream, type OpenAIResponsesCompactionResultEx } from '@floway-dev/protocols/openai-responses';
import { httpTerminal, parseHttpResponse, parseJsonBody, parseResultResponse, parseSseResponse, serializeOpenAIImagesEditsJsonBody, stripHeaders, type FormatProtocolError, type ProviderPipelines } from '@floway-dev/provider';

const { compose } = chatgptFactSpace;

// https://github.com/openai/codex/blob/c607da9f371bb66a41cc772c6ddf1989d28137d3/codex-rs/codex-api/src/requests/headers.rs#L5-L12
// https://github.com/openai/codex/blob/a16863f8704831d13e041ed7dba2c4a57a2a940b/codex-rs/core/src/responses_metadata.rs#L255-L270
const RESPONSES_HEADERS = new Set([
  'originator', 'session-id', 'session_id', 'thread-id', 'x-client-request-id',
  'x-codex-image-turn-id', 'x-codex-turn-metadata', 'x-codex-window-id',
]);

// https://github.com/openai/codex/blob/646f7c0a91b8e327d263335da68ae8ef212895ce/codex-rs/ext/image-generation/src/backend.rs#L81-L89
const keepImageHeader = (name: string) => name === 'originator' || name === 'x-codex-image-turn-id';
const keepResponsesHeader = (name: string) => RESPONSES_HEADERS.has(name);

const formatError: FormatProtocolError = (_status, message) => ({ error: { type: 'api_error', message } });

const parseObject = (bytes: Uint8Array) => {
  const parsed = parseJsonBody(bytes);
  if (!parsed.ok) return parsed;
  return isJsonObject(parsed.value)
    ? { ok: true, value: parsed.value } as const
    : { ok: false, error: new TypeError('Expected a ChatGPT JSON response object') } as const;
};

const parseCompact = (bytes: Uint8Array) => {
  const parsed = parseObject(bytes);
  if (!parsed.ok) return parsed;
  const { id, object, output } = parsed.value;
  return typeof id === 'string' && typeof object === 'string' && Array.isArray(output)
    ? { ok: true, value: parsed.value as unknown as OpenAIResponsesCompactionResultEx } as const
    : { ok: false, error: new TypeError('Expected a ChatGPT compaction response with id, object and output') } as const;
};

const imageHeaders = (headers: HttpHeaders): HttpHeaders => [
  ['x-codex-image-turn-id', trimHeader(headers, 'x-codex-image-turn-id') ?? uuidV7()],
];

export const chatgptPipelines = Object.freeze({
  openaiResponses: compose('chatgpt.openaiResponses', {
    entry: ['request.http', 'provider.upstream', 'provider.model', 'request.openaiResponses'],
    exit: ['response.http', 'response.openaiResponses', 'response.usageModelKey?'],
    stages: [
      stripHeaders('chatgpt.openaiResponses.strip-headers', keepResponsesHeader),
      normalizeDeepSeek,
      normalizeQwen,
      injectOpenAIResponsesDefaultInstructions,
      stripOpenAIResponsesUnsupportedFields,
      openaiResponsesLite,
      normalizeOpenAIResponsesOutput,
      parseSseResponse('openaiResponses', decodeOpenAIResponsesStream, formatError),
      dialOpenAIResponses((facts, modelId, installationId) => codexResponsesRequest(
        facts['request.openaiResponses'], facts['request.chatgptResponsesIdentity'], modelId, installationId, false, chatgptModelUsesResponsesLite(facts['provider.model']),
      ), formatError),
    ],
    ending: httpTerminal,
  }),
  openaiResponsesCompact: compose('chatgpt.openaiResponsesCompact', {
    entry: ['request.http', 'provider.upstream', 'provider.model', 'request.openaiResponsesCompact'],
    exit: ['response.http', 'response.openaiResponsesCompact', 'response.usageModelKey?'],
    stages: [
      stripHeaders('chatgpt.openaiResponsesCompact.strip-headers', keepResponsesHeader),
      injectOpenAIResponsesCompactDefaultInstructions,
      stripOpenAIResponsesCompactUnsupportedFields,
      openaiResponsesCompactLite,
      parseResultResponse('openaiResponsesCompact', parseCompact, formatError),
      dialOpenAIResponsesCompact((facts, modelId, installationId) => codexResponsesRequest(
        facts['request.openaiResponsesCompact'], facts['request.chatgptResponsesIdentity'], modelId, installationId, true, chatgptModelUsesResponsesLite(facts['provider.model']),
      ), formatError),
    ],
    ending: httpTerminal,
  }),
  alphaSearch: compose('chatgpt.alphaSearch', {
    entry: ['request.http', 'provider.upstream', 'provider.model', 'request.alphaSearch'],
    exit: ['response.http', 'response.alphaSearch'],
    stages: [
      stripHeaders('chatgpt.alphaSearch.strip-headers', name => name === 'x-codex-turn-metadata'),
      parseResultResponse('alphaSearch', bytes => ({ ok: true, value: bytes }), formatError),
      dialAlphaSearch(facts => {
        const payload = facts['request.alphaSearch'];
        const id = stringField(payload, 'id') ?? uuidV7();
        const metadata = trimHeader(facts['request.http'].headers, 'x-codex-turn-metadata');
        const headers: HttpHeaders = [
          ['session-id', id], ['thread-id', id], ['x-client-request-id', id], ['x-codex-window-id', `${id}:0`],
        ];
        if (metadata !== null) headers.push(['x-codex-turn-metadata', metadata]);
        return chatgptJsonRequest(CHATGPT_ALPHA_SEARCH_PATH, 'application/json', headers, { ...payload, id, model: facts['provider.model'].id });
      }, formatError),
    ],
    ending: httpTerminal,
  }),
  openaiImagesGenerations: compose('chatgpt.openaiImagesGenerations', {
    entry: ['request.http', 'provider.upstream', 'provider.model', 'request.openaiImagesGenerations'],
    exit: ['response.http', 'response.openaiImagesGenerations', 'response.usageModelKey?'],
    stages: [
      stripHeaders('chatgpt.openaiImagesGenerations.strip-headers', keepImageHeader),
      parseHttpResponse('openaiImagesGenerations', {
        select: payload => payload.stream === true ? 'stream' : 'result',
        stream: decodeOpenAIImagesGenerationsStream,
        result: parseObject,
        format: formatError,
      }),
      dialOpenAIImagesGenerations((facts, modelId) => {
        const { headers } = facts['request.http'];
        return chatgptJsonRequest(CHATGPT_OPENAI_IMAGES_GENERATIONS_PATH, 'application/json', imageHeaders(headers), {
          ...facts['request.openaiImagesGenerations'], model: modelId,
        }, trimHeader(headers, 'originator') ?? undefined);
      }, formatError),
    ],
    ending: httpTerminal,
  }),
  openaiImagesEdits: compose('chatgpt.openaiImagesEdits', {
    entry: ['request.http', 'provider.upstream', 'provider.model', 'request.openaiImagesEdits'],
    exit: ['response.http', 'response.openaiImagesEdits', 'response.usageModelKey?'],
    stages: [
      stripHeaders('chatgpt.openaiImagesEdits.strip-headers', keepImageHeader),
      parseHttpResponse('openaiImagesEdits', {
        select: payload => payload.parameters.stream === true || payload.parameters.stream === 'true' ? 'stream' : 'result',
        stream: decodeOpenAIImagesEditsStream,
        result: parseObject,
        format: formatError,
      }),
      dialOpenAIImagesEdits(async (facts, modelId) => {
        const { headers } = facts['request.http'];
        const { body, contentType } = await serializeOpenAIImagesEditsJsonBody(facts['request.openaiImagesEdits'], modelId);
        return chatgptRequest(CHATGPT_OPENAI_IMAGES_EDITS_PATH, 'application/json', imageHeaders(headers), body, contentType, trimHeader(headers, 'originator') ?? undefined);
      }, formatError),
    ],
    ending: httpTerminal,
  }),
} satisfies ProviderPipelines<ChatGPTServices, ChatGPTUpstream>);
