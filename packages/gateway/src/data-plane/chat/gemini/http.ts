// `/v1beta/models/:modelAction`, whose `:generateContent` and `:streamGenerateContent`
// actions are served through the pipeline. `:countTokens` is a second operation over this
// protocol rather than another wire under its chain, so it still goes through
// `geminiServe.countTokens`.
//
// The generate entry is a prologue and an epilogue around `geminiServePipeline`: read what
// the client sent, hand it over, and turn what the run answered with into a response.
// Everything between is stages.

import { renderGeminiError, translatorInputErrorResult } from './errors.ts';
import { geminiServePipeline } from './pipeline.ts';
import { geminiInternalRpcErrorResponse, geminiRpcErrorResponse, respondGemini } from './respond.ts';
import { geminiServe } from './serve.ts';
import type { AuthedContext } from '../../../middleware/auth.ts';
import { backgroundSchedulerFromContext } from '../../../runtime/background.ts';
import { isFrames, openPrologue, readIngress, serveThrough } from '../../pipeline/serve.ts';
import { finalizeGatewayResponse } from '../../shared/gateway-ctx.ts';
import { inboundHeaders } from '../../shared/inbound-headers.ts';
import { readRequestBody, takeRequestBody, type RequestBody } from '../../shared/request-body.ts';
import { openChatPrologue } from '../prologue.ts';
import { createNonResponsesSourceStore } from '../responses/items/store.ts';
import { createChatGatewayCtxFromHono, type ChatGatewayCtx } from '../shared/gateway-ctx.ts';
import { move } from '@floway-dev/pipeline';
import type { GeminiContent, GeminiPayload } from '@floway-dev/protocols/gemini';
import { internalErrorResult, ProviderModelsUnavailableError, toInternalDebugError } from '@floway-dev/provider';
import { TranslatorInputError } from '@floway-dev/translate';

interface GeminiModelAction {
  readonly model: string;
  readonly action: string;
}

// The Gemini wire API encodes both the model id and the action in one path
// segment (e.g. `models/gemini-2.5-pro:streamGenerateContent`). The Hono route
// captures everything after `/v1beta/models/` in a single `modelAction` param;
// we split on the trailing `:` here so each entry sees just the action and
// the resolved model id (with a leading `models/` prefix tolerated, as Google
// SDKs send it).
const parseGeminiModelAction = (modelAction: string | undefined): GeminiModelAction | Response => {
  if (!modelAction) return geminiRpcErrorResponse(404, 'Missing Gemini model action.');
  const separator = modelAction.lastIndexOf(':');
  if (separator <= 0 || separator === modelAction.length - 1) return geminiRpcErrorResponse(404, `Unknown Gemini model action: ${modelAction}`);
  return { model: modelAction.slice(0, separator).replace(/^models\//, ''), action: modelAction.slice(separator + 1) };
};

// `:countTokens` can carry either `contents` directly or a nested
// `generateContentRequest` envelope (Google's SDK shape). Normalize both to a
// single `GeminiPayload` for the rest of the chain.
const parseGeminiCountTokensPayload = (body: unknown): GeminiPayload => {
  const shape = (body ?? {}) as { contents?: GeminiContent[]; generateContentRequest?: GeminiPayload };
  return shape.generateContentRequest ?? { contents: shape.contents };
};

const parseGeminiBodyBytes = <T>(requestBody: RequestBody, project: (body: unknown) => T): T | Response => {
  try {
    const raw = JSON.parse(new TextDecoder().decode(requestBody.bytes)) as unknown;
    return project(raw);
  } catch (error) {
    return geminiInternalRpcErrorResponse(500, error);
  }
};

// Surfaces a pre-stream throw as a Gemini-RPC envelope, routing through
// `respondGemini` so the dump records the failure exactly as the sibling
// HTTP handlers do. `TranslatorInputError` renders a 400 INVALID_ARGUMENT
// envelope (caller-input violation). A `ProviderModelsUnavailableError`
// carrying an upstream HTTP body relays that body through the `api-error`
// path with `source: 'upstream'`; everything else collapses to an
// `internal-error` result rendered as the Gemini internal-error envelope
// (status, code, message, stack, cause, target_api). The throwing-
// candidate telemetry stamped in serve.ts survives onto the error row via
// `ctx.attempt.telemetry` so a mid-attempt throw still lands in
// performance_summary against the throwing upstream.
const respondWithGeminiError = async (
  c: AuthedContext,
  error: unknown,
  ctx: ChatGatewayCtx,
  wantsStream: boolean,
): Promise<Response> => {
  if (error instanceof TranslatorInputError) {
    const response = await respondGemini(c, translatorInputErrorResult(error, ctx.attempt.telemetry), wantsStream, ctx);
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
    const response = await respondGemini(c, apiErrorResult, wantsStream, ctx);
    return finalizeGatewayResponse(ctx, response);
  }
  const internalResult = internalErrorResult(500, toInternalDebugError(error), ctx.attempt.telemetry);
  const response = await respondGemini(c, internalResult, wantsStream, ctx);
  return finalizeGatewayResponse(ctx, response);
};

// Single entry for `/v1beta/models/:modelAction`. Splits the model and action
// once, then dispatches to the matching sub-handler. Keeping the parse here
// means the sub-handlers see a validated `(model, action)` pair and never
// need to re-emit "Unknown Gemini model action" on already-validated input.
export const geminiHttp = async (c: AuthedContext): Promise<Response> => {
  const parsed = parseGeminiModelAction(c.req.param('modelAction'));
  if (parsed instanceof Response) return parsed;
  if (parsed.action === 'countTokens') return await runGeminiCountTokens(c, parsed.model);
  if (parsed.action === 'generateContent' || parsed.action === 'streamGenerateContent') {
    return await runGeminiGenerate(c, parsed.model, parsed.action === 'streamGenerateContent');
  }
  return geminiRpcErrorResponse(404, `Unknown Gemini model action: ${parsed.action}`);
};

/** A body the gateway could not read is reported in the words this protocol's own clients
 *  parse, rather than as a fault of the gateway's. */
const readRequest = (bytes: Uint8Array): { type: 'ok'; payload: GeminiPayload } | { type: 'invalid'; message: string } => {
  try {
    return { type: 'ok', payload: JSON.parse(new TextDecoder().decode(bytes)) as GeminiPayload };
  } catch (error) {
    return { type: 'invalid', message: error instanceof Error ? error.message : String(error) };
  }
};

const runGeminiGenerate = async (c: AuthedContext, model: string, wantsStream: boolean): Promise<Response> => {
  const ingress = await readIngress(c);
  const request = readRequest(ingress.body.bytes);
  if (request.type === 'invalid') {
    // A request the gateway could not read never reaches a pipeline: there is no model to
    // resolve and no attempt to make, so there is nothing for a run to record.
    const refused = openPrologue(c, ingress, { wantsStream: false });
    refused.gateway.dump?.error('gateway');
    return finalizeGatewayResponse(
      refused.gateway,
      Response.json(renderGeminiError(400, request.message), { status: 400 }),
    );
  }

  const { payload } = request;
  const prologue = openChatPrologue(c, ingress, {
    wantsStream,
    model,
    storeFactory: apiKey => createNonResponsesSourceStore(apiKey.id),
  });

  return await serveThrough(
    c,
    prologue,
    geminiServePipeline(payload),
    move({
      'ingress.http.headers': prologue.headers,
      'ingress.chat.sourceProtocol': 'gemini',
      'ingress.chat.gemini.wantsStream': wantsStream,
      'request.chat.gemini': payload,
      // Gemini carries the model in the path rather than the body, so the id the run
      // resolves against is the one the route split off.
      'serve.model': model,
    }) as never,
    facts => {
      const rendered = facts['response.chat.gemini.rendered'];
      if (isFrames(rendered)) return { frames: rendered };
      return { body: JSON.stringify(rendered), contentType: 'application/json' };
    },
    facts => facts['response.chat.gemini.streamedUsage'],
  );
};

const runGeminiCountTokens = async (c: AuthedContext, model: string): Promise<Response> => {
  const requestBody = await readRequestBody(c);
  const payload = parseGeminiBodyBytes(requestBody, parseGeminiCountTokensPayload);
  if (payload instanceof Response) return payload;

  const ctx = createChatGatewayCtxFromHono(c, { wantsStream: false, requestBody: takeRequestBody(requestBody), model, backgroundScheduler: backgroundSchedulerFromContext(c) }, apiKey => createNonResponsesSourceStore(apiKey.id));
  try {
    const result = await geminiServe.countTokens({ payload, ctx, model, headers: inboundHeaders(c) });
    const response = await respondGemini(c, result, false, ctx);
    return finalizeGatewayResponse(ctx, response);
  } catch (error) {
    return await respondWithGeminiError(c, error, ctx, false);
  }
};
