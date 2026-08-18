import { translatorInputErrorResult } from './errors.ts';
import { geminiGenerateContentInternalRpcErrorResponse, geminiGenerateContentRpcErrorResponse, respondGeminiGenerateContent } from './respond.ts';
import { geminiGenerateContentServe } from './serve.ts';
import type { AuthedContext } from '../../../middleware/auth.ts';
import { backgroundSchedulerFromContext } from '../../../runtime/background.ts';
import { finalizeGatewayResponse } from '../../shared/gateway-ctx.ts';
import { inboundHeaders } from '../../shared/inbound-headers.ts';
import { readRequestBody, takeRequestBody, type RequestBody } from '../../shared/request-body.ts';
import { createNonOpenAIResponsesSourceStore } from '../openai-responses/items/store.ts';
import { createChatGatewayCtxFromHono, type ChatGatewayCtx } from '../shared/gateway-ctx.ts';
import type { GeminiGenerateContentContent, GeminiGenerateContentPayload } from '@floway-dev/protocols/gemini-generate-content';
import { internalErrorResult, ProviderModelsUnavailableError, toInternalDebugError } from '@floway-dev/provider';
import { TranslatorInputError } from '@floway-dev/translate';

interface GeminiGenerateContentModelAction {
  readonly model: string;
  readonly action: string;
}

// The Gemini generateContent wire API encodes both the model id and the action in one path
// segment (e.g. `models/gemini-2.5-pro:streamGenerateContent`). The Hono route
// captures everything after `/v1beta/models/` in a single `modelAction` param;
// we split on the trailing `:` here so each entry sees just the action and
// the resolved model id (with a leading `models/` prefix tolerated, as Google
// SDKs send it).
const parseGeminiGenerateContentModelAction = (modelAction: string | undefined): GeminiGenerateContentModelAction | Response => {
  if (!modelAction) return geminiGenerateContentRpcErrorResponse(404, 'Missing Gemini model action.');
  const separator = modelAction.lastIndexOf(':');
  if (separator <= 0 || separator === modelAction.length - 1) return geminiGenerateContentRpcErrorResponse(404, `Unknown Gemini model action: ${modelAction}`);
  return { model: modelAction.slice(0, separator).replace(/^models\//, ''), action: modelAction.slice(separator + 1) };
};

// `:countTokens` can carry either `contents` directly or a nested
// `generateContentRequest` envelope (Google's SDK shape). Normalize both to a
// single `GeminiGenerateContentPayload` for the rest of the chain.
const parseGeminiGenerateContentCountTokensPayload = (body: unknown): GeminiGenerateContentPayload => {
  const shape = (body ?? {}) as { contents?: GeminiGenerateContentContent[]; generateContentRequest?: GeminiGenerateContentPayload };
  return shape.generateContentRequest ?? { contents: shape.contents };
};

const parseGeminiGenerateContentBodyBytes = <T>(requestBody: RequestBody, project: (body: unknown) => T): T | Response => {
  try {
    const raw = JSON.parse(new TextDecoder().decode(requestBody.bytes)) as unknown;
    return project(raw);
  } catch (error) {
    return geminiGenerateContentInternalRpcErrorResponse(500, error);
  }
};

// Surfaces a pre-stream throw as a Gemini-generateContent-RPC envelope, routing through
// `respondGeminiGenerateContent` so the dump records the failure exactly as the sibling
// HTTP handlers do. `TranslatorInputError` renders a 400 INVALID_ARGUMENT
// envelope (caller-input violation). A `ProviderModelsUnavailableError`
// carrying an upstream HTTP body relays that body through the `api-error`
// path with `source: 'upstream'`; everything else collapses to an
// `internal-error` result rendered as the Gemini generateContent internal-error envelope
// (status, code, message, stack, cause, target_api). The throwing-
// candidate telemetry stamped in serve.ts survives onto the error row via
// `ctx.attempt.telemetry` so a mid-attempt throw still lands in
// performance_summary against the throwing upstream.
const respondWithGeminiGenerateContentError = async (
  c: AuthedContext,
  error: unknown,
  ctx: ChatGatewayCtx,
  wantsStream: boolean,
): Promise<Response> => {
  if (error instanceof TranslatorInputError) {
    const response = await respondGeminiGenerateContent(c, translatorInputErrorResult(error, ctx.attempt.telemetry), wantsStream, ctx);
    return finalizeGatewayResponse(ctx, response);
  }
  if (error instanceof ProviderModelsUnavailableError && error.httpResponse) {
    const { status, headers, body } = error.httpResponse;
    const apiErrorResult = {
      type: 'api-error' as const,
      source: 'upstream' as const,
      status,
      headers: new Headers(headers),
      body: new TextEncoder().encode(body),
    };
    const response = await respondGeminiGenerateContent(c, apiErrorResult, wantsStream, ctx);
    return finalizeGatewayResponse(ctx, response);
  }
  const internalResult = internalErrorResult(500, toInternalDebugError(error), ctx.attempt.telemetry);
  const response = await respondGeminiGenerateContent(c, internalResult, wantsStream, ctx);
  return finalizeGatewayResponse(ctx, response);
};

// Single entry for `/v1beta/models/:modelAction`. Splits the model and action
// once, then dispatches to the matching sub-handler. Keeping the parse here
// means the sub-handlers see a validated `(model, action)` pair and never
// need to re-emit "Unknown Gemini model action" on already-validated input.
export const geminiGenerateContentHttp = async (c: AuthedContext): Promise<Response> => {
  const parsed = parseGeminiGenerateContentModelAction(c.req.param('modelAction'));
  if (parsed instanceof Response) return parsed;
  if (parsed.action === 'countTokens') return await runGeminiGenerateContentCountTokens(c, parsed.model);
  if (parsed.action === 'generateContent' || parsed.action === 'streamGenerateContent') {
    return await runGeminiGenerateContentGenerate(c, parsed.model, parsed.action === 'streamGenerateContent');
  }
  return geminiGenerateContentRpcErrorResponse(404, `Unknown Gemini model action: ${parsed.action}`);
};

const runGeminiGenerateContentGenerate = async (c: AuthedContext, model: string, wantsStream: boolean): Promise<Response> => {
  const requestBody = await readRequestBody(c);
  const payload = parseGeminiGenerateContentBodyBytes(requestBody, body => body as GeminiGenerateContentPayload);
  if (payload instanceof Response) return payload;

  const ctx = createChatGatewayCtxFromHono(c, { wantsStream, requestBody: takeRequestBody(requestBody), model, backgroundScheduler: backgroundSchedulerFromContext(c) }, apiKey => createNonOpenAIResponsesSourceStore(apiKey.id));
  try {
    const result = await geminiGenerateContentServe.generate({ payload, ctx, model, headers: inboundHeaders(c) });
    const response = await respondGeminiGenerateContent(c, result, wantsStream, ctx);
    return finalizeGatewayResponse(ctx, response);
  } catch (error) {
    return await respondWithGeminiGenerateContentError(c, error, ctx, wantsStream);
  }
};

const runGeminiGenerateContentCountTokens = async (c: AuthedContext, model: string): Promise<Response> => {
  const requestBody = await readRequestBody(c);
  const payload = parseGeminiGenerateContentBodyBytes(requestBody, parseGeminiGenerateContentCountTokensPayload);
  if (payload instanceof Response) return payload;

  const ctx = createChatGatewayCtxFromHono(c, { wantsStream: false, requestBody: takeRequestBody(requestBody), model, backgroundScheduler: backgroundSchedulerFromContext(c) }, apiKey => createNonOpenAIResponsesSourceStore(apiKey.id));
  try {
    const result = await geminiGenerateContentServe.countTokens({ payload, ctx, model, headers: inboundHeaders(c) });
    const response = await respondGeminiGenerateContent(c, result, false, ctx);
    return finalizeGatewayResponse(ctx, response);
  } catch (error) {
    return await respondWithGeminiGenerateContentError(c, error, ctx, false);
  }
};
