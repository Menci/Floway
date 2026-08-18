// POST /v1/responses and POST /v1/responses/compact, both served through their own pipeline.
// Generation is one chain; compaction is a second operation over the same protocol and is a
// chain of its own rather than another wire under the first.
//
// Each entry is a prologue and an epilogue around that chain: read what the client sent, hand
// it over, and turn what the run answered with into a response. Everything between is stages,
// the stored-items membrane included — which is why a continuation that does not resolve is
// answered by the chain on both routes rather than caught as a throw on either.

import { openaiResponsesCompactPipeline } from './compact.ts';
import { createOpenAIResponsesHttpStore } from './items/store.ts';
import { openaiResponsesServePipeline } from './pipeline.ts';
import type { AuthedContext } from '../../../middleware/auth.ts';
import { isFrames, openPrologue, readIngress, serveThrough, type Ingress } from '../../pipeline/serve.ts';
import { finalizeGatewayResponse } from '../../shared/gateway-ctx.ts';
import { openChatPrologue } from '../prologue.ts';
import { move } from '@floway-dev/pipeline';
import type { CanonicalOpenAIResponsesPayload, OpenAIResponsesRequestPayload } from '@floway-dev/protocols/openai-responses';
import { canonicalizeOpenAIResponsesPayload, TranslatorInputError } from '@floway-dev/translate';

/** The read, as a value rather than a throw, because a pipelined entry decides what to do
 *  about a body it could not read before it opens a run rather than after one unwound.
 *
 *  What the reader rejected travels with the rejection. This protocol's envelope names the
 *  field at fault and the code for the condition, and those are statements only the reader
 *  can make: `input` and `input[0]` are different sentences, and a body with no `model` is
 *  refused in words OpenAI's own clients already parse. */
const readRequest = (bytes: Uint8Array):
  | { type: 'ok'; payload: CanonicalOpenAIResponsesPayload }
  | { type: 'invalid'; message: string; param?: string; code?: string } => {
  try {
    return { type: 'ok', payload: canonicalizeOpenAIResponsesPayload(JSON.parse(new TextDecoder().decode(bytes)) as OpenAIResponsesRequestPayload) };
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

/** A request the gateway refused before it reached a pipeline: there is no model to resolve
 *  and no attempt to make, so there is nothing for a run to record beyond the refusal. */
const refuse = (c: AuthedContext, ingress: Ingress, invalid: { message: string; param?: string; code?: string }): Response => {
  const refused = openPrologue(c, ingress, { wantsStream: false });
  refused.gateway.dump?.error('gateway');
  return finalizeGatewayResponse(refused.gateway, invalidRequestResponse(invalid));
};

export const openaiResponsesHttp = {
  generate: async (c: AuthedContext): Promise<Response> => {
    const ingress = await readIngress(c);
    const request = readRequest(ingress.body.bytes);
    if (request.type === 'invalid') return refuse(c, ingress, request);

    const { payload } = request;
    const wantsStream = payload.stream === true;
    const prologue = openChatPrologue(c, ingress, {
      wantsStream,
      model: payload.model,
      storeFactory: (apiKey, requestStartedAt) => createOpenAIResponsesHttpStore(apiKey, requestStartedAt, payload.store ?? undefined),
    });

    return await serveThrough(
      c,
      prologue,
      openaiResponsesServePipeline(payload),
      move({
        'ingress.http.headers': prologue.headers,
        'ingress.chat.sourceProtocol': 'openaiResponses',
        'ingress.chat.openaiResponses.wantsStream': wantsStream,
        'request.chat.openaiResponses': payload,
        'serve.model': payload.model,
      }) as never,
      facts => {
        const rendered = facts['response.chat.openaiResponses.rendered'];
        if (isFrames(rendered)) return { frames: rendered };
        return { body: JSON.stringify(rendered), contentType: 'application/json' };
      },
      facts => facts['response.chat.openaiResponses.streamedUsage'],
    );
  },

  compact: async (c: AuthedContext): Promise<Response> => {
    const ingress = await readIngress(c);
    const request = readRequest(ingress.body.bytes);
    if (request.type === 'invalid') return refuse(c, ingress, request);

    const { payload } = request;
    const prologue = openChatPrologue(c, ingress, {
      wantsStream: false,
      model: payload.model,
      storeFactory: (apiKey, requestStartedAt) => createOpenAIResponsesHttpStore(apiKey, requestStartedAt, payload.store ?? undefined),
    });

    return await serveThrough(
      c,
      prologue,
      openaiResponsesCompactPipeline(payload),
      move({
        'ingress.http.headers': prologue.headers,
        'ingress.chat.sourceProtocol': 'openaiResponses',
        'request.chat.openaiResponses': payload,
        'serve.model': payload.model,
      }) as never,
      // A compaction is one resource however the turn went, so there is never a stream to
      // write: the frames it came as were read into that resource before the run answered.
      facts => ({ body: JSON.stringify(facts['response.chat.openaiResponses.rendered']), contentType: 'application/json' }),
      facts => facts['response.chat.openaiResponses.streamedUsage'],
    );
  },
};
