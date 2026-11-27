import { geminiGenerateContentInternalRpcErrorResponse, geminiGenerateContentRpcErrorResponse, respondGeminiGenerateContent } from './respond.ts';
import { geminiGenerateContentServe } from './serve.ts';
import type { AuthedContext } from '../../../middleware/auth.ts';
import { backgroundSchedulerFromContext } from '../../../runtime/background.ts';
import { finalizeGatewayResponse } from '../../shared/gateway-ctx.ts';
import { inboundHeaders } from '../../shared/inbound-headers.ts';
import { readRequestBody, takeRequestBody, type RequestBody } from '../../shared/request-body.ts';
import { createNonOpenAIResponsesSourceStore } from '../openai-responses/items/store.ts';
import { createChatGatewayCtxFromHono, type ChatGatewayCtx } from '../shared/gateway-ctx.ts';
import type { GeminiCountTokensPayload, GeminiGenerateContentPayload } from '@floway-dev/protocols/gemini-generate-content';
import { internalErrorResult, toInternalDebugError } from '@floway-dev/upstream';

interface GeminiGenerateContentModelAction {
  readonly model: string;
  readonly action: string;
}

// The Gemini generateContent wire API encodes both the model id and the action in one path
// segment (e.g. `models/gemini-2.5-pro:streamGenerateContent`). Both the
// `v1` and `v1beta` routes capture everything after `/models/` in a single
// `modelAction` param; we split on the trailing `:` here so each entry sees
// just the action and the resolved model id (with a leading `models/` prefix
// tolerated, as Google SDKs send it).
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
  const shape = body as GeminiCountTokensPayload;
  if (shape.generateContentRequest !== undefined) return shape.generateContentRequest;
  return { contents: shape.contents ?? [] };
};

const parseGeminiGenerateContentBodyBytes = <T>(requestBody: RequestBody, project: (body: unknown) => T): T | Response => {
  try {
    const raw = JSON.parse(new TextDecoder().decode(requestBody.bytes)) as unknown;
    return project(raw);
  } catch (error) {
    return geminiGenerateContentInternalRpcErrorResponse(500, error);
  }
};

// Surfaces a pre-stream throw as a Gemini generateContent internal-error RPC
// envelope (status, code, message, stack, cause, target_api) through
// `respondGeminiGenerateContent` so dumps record the failure the same way
// sibling HTTP handlers do. The throwing-candidate telemetry stamped by
// `iterateCandidates` survives onto the error row via `ctx.attempt.telemetry`
// so a mid-attempt throw still lands in performance_summary against that upstream.
const respondWithGeminiGenerateContentError = async (
  c: AuthedContext,
  error: unknown,
  ctx: ChatGatewayCtx,
  wantsStream: boolean,
): Promise<Response> => {
  const internalResult = internalErrorResult(500, toInternalDebugError(error), ctx.attempt.telemetry);
  const response = await respondGeminiGenerateContent(c, internalResult, wantsStream, ctx);
  return finalizeGatewayResponse(ctx, response);
};

// Single entry for `/v1/models/:modelAction` and `/v1beta/models/:modelAction`.
// Splits the model and action once, then dispatches to the matching
// sub-handler. Keeping the parse here means the sub-handlers see a validated
// `(model, action)` pair and never need to re-emit "Unknown Gemini model
// action" on already-validated input.
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
