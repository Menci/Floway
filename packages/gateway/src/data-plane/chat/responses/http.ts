// POST /v1/responses, served through the pipeline, and POST /v1/responses/compact beside it
// — a second operation over this protocol rather than another wire under its chain, so it
// still goes through `responsesServe.compact`.
//
// The generate entry is a prologue and an epilogue around `responsesServePipeline`: read
// what the client sent, hand it over, and turn what the run answered with into a response.
// Everything between is stages, the stored-items membrane included — which is why a
// continuation that does not resolve is answered by the chain here and still caught as a
// throw on the compact route, which has not moved.

import { responsesInputErrorResult } from './errors.ts';
import { createResponsesHttpStore } from './items/store.ts';
import { responsesServePipeline } from './pipeline.ts';
import { respondResponses, respondResponsesFailure } from './respond.ts';
import { PreviousResponseNotFoundError } from './serve-prep.ts';
import { responsesServe } from './serve.ts';
import type { AuthedContext } from '../../../middleware/auth.ts';
import { backgroundSchedulerFromContext } from '../../../runtime/background.ts';
import { isFrames, openPrologue, readIngress, serveThrough } from '../../pipeline/serve.ts';
import { createGatewayCtxFromHono, finalizeGatewayResponse, type GatewayCtx } from '../../shared/gateway-ctx.ts';
import { inboundHeaders } from '../../shared/inbound-headers.ts';
import { readRequestBody, takeRequestBody, type RequestBody } from '../../shared/request-body.ts';
import { settle } from '../../shared/telemetry/settle.ts';
import { openChatPrologue } from '../prologue.ts';
import { createChatGatewayCtxFromHono, type ChatGatewayCtx } from '../shared/gateway-ctx.ts';
import { providerModelsUnavailableResponse } from '../shared/upstream-models-error.ts';
import { move } from '@floway-dev/pipeline';
import type { CanonicalResponsesPayload, ResponsesRequestPayload } from '@floway-dev/protocols/responses';
import { internalErrorResult, toInternalDebugError } from '@floway-dev/provider';
import { canonicalizeResponsesPayload, TranslatorInputError } from '@floway-dev/translate';

// OpenAI's verbatim previous_response_not_found envelope. Codex compares this
// body byte-for-byte against upstream — see the cross-references on
// `PreviousResponseNotFoundError` in serve-prep.ts.
const previousResponseNotFoundResponse = (id: string): Response =>
  Response.json(
    {
      error: {
        message: `Previous response with id '${id}' not found.`,
        type: 'invalid_request_error',
        param: 'previous_response_id',
        code: 'previous_response_not_found',
      },
    },
    { status: 400 },
  );

// Surfaces a pre-stream throw (malformed JSON body, an interceptor crash,
// etc.) as a Responses-shaped 502 with the same internal-error envelope the
// in-flow `internal-error` ExecuteResult produces. A
// `ProviderModelsUnavailableError` carrying an upstream HTTP body relays
// that body verbatim — the upstream's `/models` 401 IS the diagnostic. The
// caller passes its outer `ctx` when one was already constructed (so the
// dump row preserves the model attribution the request-time
// `requestedModel` stamped, and the throwing-candidate telemetry stamped
// in serve.ts survives onto the error row); a fresh ctx is minted only
// for pre-parse failures where no payload was available to read model from.
const respondWithInternalError = async (c: AuthedContext, error: unknown, requestBody: RequestBody, ctx?: GatewayCtx): Promise<Response> => {
  const verbatim = providerModelsUnavailableResponse(error);
  if (verbatim !== null) return verbatim;
  const effectiveCtx = ctx ?? createGatewayCtxFromHono(c, { wantsStream: false, requestBody: takeRequestBody(requestBody), backgroundScheduler: backgroundSchedulerFromContext(c) });
  const result = internalErrorResult(502, toInternalDebugError(error), effectiveCtx.attempt.telemetry);
  const response = respondResponsesFailure(result, effectiveCtx);
  return finalizeGatewayResponse(effectiveCtx, response);
};

// Pre-stream throw dispatcher. `PreviousResponseNotFoundError` and the
// translator-input case render protocol-shaped 400s; anything else falls
// through to the internal-error 502 path.
const respondToThrow = async (c: AuthedContext, error: unknown, requestBody: RequestBody, ctx?: GatewayCtx): Promise<Response> => {
  if (error instanceof PreviousResponseNotFoundError) {
    const response = previousResponseNotFoundResponse(error.previousResponseId);
    ctx?.dump?.error('gateway');
    return ctx ? finalizeGatewayResponse(ctx, response) : response;
  }
  if (error instanceof TranslatorInputError) {
    const effectiveCtx = ctx ?? createGatewayCtxFromHono(c, { wantsStream: false, requestBody: takeRequestBody(requestBody), backgroundScheduler: backgroundSchedulerFromContext(c) });
    const response = respondResponsesFailure(responsesInputErrorResult(error, effectiveCtx.attempt.telemetry), effectiveCtx);
    return finalizeGatewayResponse(effectiveCtx, response);
  }
  return await respondWithInternalError(c, error, requestBody, ctx);
};

const parsePayload = (bytes: Uint8Array): CanonicalResponsesPayload =>
  canonicalizeResponsesPayload(JSON.parse(new TextDecoder().decode(bytes)) as ResponsesRequestPayload);

/** The same read, as a value rather than a throw, because a pipelined entry decides what to
 *  do about a body it could not read before it opens a run rather than after one unwound.
 *
 *  What the reader rejected travels with the rejection. This protocol's envelope names the
 *  field at fault and the code for the condition, and those are statements only the reader
 *  can make: `input` and `input[0]` are different sentences, and a body with no `model` is
 *  refused in words OpenAI's own clients already parse. */
const readRequest = (bytes: Uint8Array):
  | { type: 'ok'; payload: CanonicalResponsesPayload }
  | { type: 'invalid'; message: string; param?: string; code?: string } => {
  try {
    return { type: 'ok', payload: parsePayload(bytes) };
  } catch (error) {
    if (!(error instanceof TranslatorInputError)) {
      return { type: 'invalid', message: error instanceof Error ? error.message : String(error) };
    }
    return {
      type: 'invalid',
      message: error.message,
      ...(error.param === undefined ? {} : { param: error.param }),
      ...(error.code === undefined ? {} : { code: error.code }),
    };
  }
};

/** The rejection, as this protocol's clients read one. A reader that named neither field
 *  still fills both slots, because the envelope declares them and `input` is where a body
 *  this endpoint could not read went wrong. */
const invalidRequestResponse = (invalid: { message: string; param?: string; code?: string }): Response =>
  Response.json(
    {
      error: {
        message: invalid.message,
        type: 'invalid_request_error',
        param: invalid.param ?? 'input',
        code: invalid.code ?? null,
      },
    },
    { status: 400 },
  );

export const responsesHttp = {
  generate: async (c: AuthedContext): Promise<Response> => {
    const ingress = await readIngress(c);
    const request = readRequest(ingress.body.bytes);
    if (request.type === 'invalid') {
      // A request the gateway could not read never reaches a pipeline: there is no model to
      // resolve and no attempt to make, so there is nothing for a run to record.
      const refused = openPrologue(c, ingress, { wantsStream: false });
      refused.gateway.dump?.error('gateway');
      return finalizeGatewayResponse(refused.gateway, invalidRequestResponse(request));
    }

    const { payload } = request;
    const wantsStream = payload.stream === true;
    const prologue = openChatPrologue(c, ingress, {
      wantsStream,
      model: payload.model,
      storeFactory: (apiKey, requestStartedAt) => createResponsesHttpStore(apiKey, requestStartedAt, payload.store ?? undefined),
    });

    return await serveThrough(
      c,
      prologue,
      responsesServePipeline(payload),
      move({
        'ingress.http.headers': prologue.headers,
        'ingress.chat.sourceProtocol': 'responses',
        'ingress.chat.responses.wantsStream': wantsStream,
        'request.chat.responses': payload,
        'serve.model': payload.model,
      }) as never,
      facts => {
        const rendered = facts['response.chat.responses.rendered'];
        if (isFrames(rendered)) return { frames: rendered };
        return { body: JSON.stringify(rendered), contentType: 'application/json' };
      },
      facts => facts['response.chat.responses.streamedUsage'],
    );
  },

  compact: async (c: AuthedContext): Promise<Response> => {
    const requestBody = await readRequestBody(c);
    let ctx: ChatGatewayCtx | undefined;
    try {
      const payload = parsePayload(requestBody.bytes);
      ctx = createChatGatewayCtxFromHono(c, { wantsStream: false, requestBody: takeRequestBody(requestBody), model: payload.model, backgroundScheduler: backgroundSchedulerFromContext(c) }, (apiKey, requestStartedAt) => createResponsesHttpStore(apiKey, requestStartedAt, payload.store ?? undefined));
      const result = await responsesServe.compact({ payload, ctx, headers: inboundHeaders(c) });
      if (result.type === 'result') {
        // Compact drains the upstream stream into a single compaction
        // resource with no per-token stamps; recordPerformance therefore
        // lands in the neutral bucket (request counted, no TTFT/TPOT sample).
        // `status` is not a `CompactResource` key — it survives the spread
        // from the upstream turn — and it is authoritative for failure: a
        // compact that surfaced as `response.failed` must be recorded as such
        // so it shows up in the error column instead of masquerading as a
        // success.
        const failed = result.result.status === 'failed';
        if (failed) {
          ctx.dump?.failed('compact envelope status=failed');
        } else {
          ctx.dump?.success(result.modelIdentity, result.usage);
        }
        settle(
          ctx,
          result.performance,
          result.modelIdentity,
          result.usage,
          failed,
        );
        const compactResponse = Response.json(result.result);
        return finalizeGatewayResponse(ctx, compactResponse);
      }
      const response = await respondResponses(c, result, false, ctx, payload);
      return finalizeGatewayResponse(ctx, response);
    } catch (error) {
      return await respondToThrow(c, error, requestBody, ctx);
    }
  },
};
