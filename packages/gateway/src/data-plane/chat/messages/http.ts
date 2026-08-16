// POST /v1/messages, served through the pipeline, and POST /v1/messages/count_tokens beside
// it — a second operation over this protocol rather than another wire under its chain, so it
// still goes through `messagesServe.countTokens`.
//
// The generate entry is a prologue and an epilogue around `messagesServePipeline`: read what
// the client sent, hand it over, and turn what the run answered with into a response.
// Everything between is stages.

import { renderMessagesError, translatorInputErrorResult } from './errors.ts';
import { messagesKeepAlive, messagesServePipeline } from './pipeline.ts';
import { respondMessages } from './respond.ts';
import { messagesServe } from './serve.ts';
import type { AuthedContext } from '../../../middleware/auth.ts';
import { backgroundSchedulerFromContext } from '../../../runtime/background.ts';
import { isFrames, openPrologue, readIngress, serveThrough, type Ingress } from '../../pipeline/serve.ts';
import { createGatewayCtxFromHono, finalizeGatewayResponse, type GatewayCtx } from '../../shared/gateway-ctx.ts';
import { inboundHeaders } from '../../shared/inbound-headers.ts';
import { readRequestBody, takeRequestBody, type RequestBody } from '../../shared/request-body.ts';
import { openChatPrologue } from '../prologue.ts';
import { createNonResponsesSourceStore } from '../responses/items/store.ts';
import { createChatGatewayCtxFromHono, type ChatGatewayCtx } from '../shared/gateway-ctx.ts';
import { providerModelsUnavailableResponse } from '../shared/upstream-models-error.ts';
import { move } from '@floway-dev/pipeline';
import type { MessagesPayload } from '@floway-dev/protocols/messages';
import { internalErrorResult, toInternalDebugError } from '@floway-dev/provider';
import { TranslatorInputError } from '@floway-dev/translate';

// Reject `anthropic_beta` / `betas` in the body; the Messages protocol carries
// them via the `anthropic-beta` HTTP header.
const rejectBodyBetaResponse = (payload: MessagesPayload): Response | null => {
  const record = payload as unknown as Record<string, unknown>;
  const param = Object.hasOwn(record, 'anthropic_beta')
    ? 'anthropic_beta'
    : Object.hasOwn(record, 'betas')
      ? 'betas'
      : null;
  if (!param) return null;
  return Response.json(
    {
      error: {
        message: `${param} in the Messages request body is not supported; send Anthropic beta flags with the anthropic-beta HTTP header.`,
        type: 'invalid_request_error',
        param,
      },
    },
    { status: 400 },
  );
};

// Surfaces a pre-stream throw (malformed JSON body, an interceptor crash,
// etc.) as a Messages-shaped 502 with the same internal-error envelope the
// in-flow `internal-error` ExecuteResult produces. The caller passes its
// outer `ctx` when one was already constructed (so the dump row preserves
// the model attribution the request-time `requestedModel` stamped, and the
// throwing-candidate telemetry stamped in serve.ts survives onto the error
// row); a fresh ctx is minted only for pre-parse failures where no payload
// was available to read model from.
const respondWithInternalError = async (c: AuthedContext, error: unknown, requestBody: RequestBody, ctx?: GatewayCtx): Promise<Response> => {
  const verbatim = providerModelsUnavailableResponse(error);
  if (verbatim !== null) return verbatim;
  const effectiveCtx = ctx ?? createGatewayCtxFromHono(c, { wantsStream: false, requestBody: takeRequestBody(requestBody), backgroundScheduler: backgroundSchedulerFromContext(c) });
  const result = internalErrorResult(502, toInternalDebugError(error), effectiveCtx.attempt.telemetry);
  const response = await respondMessages(c, result, false, effectiveCtx);
  return finalizeGatewayResponse(effectiveCtx, response);
};

// Pre-stream caller-input failure raised by a translator → Messages-shaped
// 400 invalid_request_error envelope. Anything else falls through to the
// internal-error 502 path.
const respondToThrow = async (c: AuthedContext, error: unknown, requestBody: RequestBody, ctx?: GatewayCtx): Promise<Response> => {
  if (!(error instanceof TranslatorInputError)) return await respondWithInternalError(c, error, requestBody, ctx);
  const effectiveCtx = ctx ?? createGatewayCtxFromHono(c, { wantsStream: false, requestBody: takeRequestBody(requestBody), backgroundScheduler: backgroundSchedulerFromContext(c) });
  const response = await respondMessages(c, translatorInputErrorResult(error, effectiveCtx.attempt.telemetry), false, effectiveCtx);
  return finalizeGatewayResponse(effectiveCtx, response);
};

/** A body the gateway could not read is reported in the words this protocol's own clients
 *  parse, rather than as a fault of the gateway's. */
const readRequest = (bytes: Uint8Array): { type: 'ok'; payload: MessagesPayload } | { type: 'invalid'; message: string } => {
  try {
    return { type: 'ok', payload: JSON.parse(new TextDecoder().decode(bytes)) as MessagesPayload };
  } catch (error) {
    return { type: 'invalid', message: error instanceof Error ? error.message : String(error) };
  }
};

/** A request the gateway refused before it reached a pipeline: there is no model to resolve
 *  and no attempt to make, so there is nothing for a run to record beyond the refusal. */
const refuse = (c: AuthedContext, ingress: Ingress, response: Response): Response => {
  const refused = openPrologue(c, ingress, { wantsStream: false });
  refused.gateway.dump?.error('gateway');
  return finalizeGatewayResponse(refused.gateway, response);
};

const parsePayload = (requestBody: RequestBody): MessagesPayload =>
  JSON.parse(new TextDecoder().decode(requestBody.bytes)) as MessagesPayload;

export const messagesHttp = {
  generate: async (c: AuthedContext): Promise<Response> => {
    const ingress = await readIngress(c);
    const request = readRequest(ingress.body.bytes);
    if (request.type === 'invalid') {
      return refuse(c, ingress, Response.json(renderMessagesError(400, request.message), { status: 400 }));
    }

    const { payload } = request;
    const rejected = rejectBodyBetaResponse(payload);
    if (rejected !== null) return refuse(c, ingress, rejected);

    const wantsStream = payload.stream === true;
    const prologue = openChatPrologue(c, ingress, {
      wantsStream,
      model: payload.model,
      storeFactory: apiKey => createNonResponsesSourceStore(apiKey.id),
    });

    return await serveThrough(
      c,
      prologue,
      messagesServePipeline(payload),
      move({
        'ingress.http.headers': prologue.headers,
        'ingress.chat.sourceProtocol': 'messages',
        'ingress.chat.messages.wantsStream': wantsStream,
        'request.chat.messages': payload,
        'serve.model': payload.model,
      }) as never,
      facts => {
        const rendered = facts['response.chat.messages.rendered'];
        // Anthropic defines a `ping` event and its clients read one, so an idle connection is
        // held open with that rather than with a comment no client sees.
        if (isFrames(rendered)) return { frames: rendered, keepAlive: messagesKeepAlive };
        return { body: JSON.stringify(rendered), contentType: 'application/json' };
      },
      facts => {
        const streamed = facts['response.chat.messages.streamedUsage'];
        // Two readings this chain does not hand up. A refusal that never reached an upstream
        // leaves the key unwritten rather than null, and the meter that does write it resolves
        // what was billed without saying whether the frames reached their terminator — so a
        // stream that stopped short settles here as one that finished. Both belong to the
        // chain: a family whose meter reports the outcome hands up a `StreamOutcome`, and this
        // adapter goes with it.
        return streamed === null || streamed === undefined
          ? null
          : streamed.then(billable => ({ billable, failed: false }));
      },
    );
  },

  countTokens: async (c: AuthedContext): Promise<Response> => {
    const requestBody = await readRequestBody(c);
    let ctx: ChatGatewayCtx | undefined;
    try {
      const payload = parsePayload(requestBody);
      const rejected = rejectBodyBetaResponse(payload);
      if (rejected) return rejected;

      ctx = createChatGatewayCtxFromHono(c, { wantsStream: false, requestBody: takeRequestBody(requestBody), model: payload.model, backgroundScheduler: backgroundSchedulerFromContext(c) }, apiKey => createNonResponsesSourceStore(apiKey.id));
      const result = await messagesServe.countTokens({ payload, ctx, headers: inboundHeaders(c) });
      const response = await respondMessages(c, result, false, ctx);
      return finalizeGatewayResponse(ctx, response);
    } catch (error) {
      return await respondToThrow(c, error, requestBody, ctx);
    }
  },
};
