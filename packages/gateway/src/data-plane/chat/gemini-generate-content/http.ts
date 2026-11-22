import {
  geminiGenerateContentInternalErrorPayload,
  geminiGenerateContentRpcErrorPayload,
  googleRpcHttpStatusCode,
  normalizeGeminiChatFailure,
} from './errors.ts';
import {
  geminiGenerateContentCountTokensPipeline,
  geminiGenerateContentPipeline,
  type GeminiGenerateContentCountTokensPipelineInput,
  type GeminiGenerateContentPipelineInput,
} from './pipeline.ts';
import type { AuthedContext } from '../../../middleware/auth.ts';
import { backgroundSchedulerFromContext } from '../../../runtime/background.ts';
import { buildDownstreamWireUrl, inboundHeaderEntriesFromHono } from '../../pipeline/index.ts';
import { finalizeGatewayResponse } from '../../shared/gateway-ctx.ts';
import { readRequestBody, takeRequestBody, type RequestBody } from '../../shared/request-body.ts';
import { createNonOpenAIResponsesSourceStore } from '../openai-responses/items/store.ts';
import { chatApiErrorToDownstreamOutcome, createChatPipelineServices, runGatewayChatHttpPipeline } from '../pipeline/index.ts';
import { createChatGatewayCtxFromHono, type ChatGatewayCtx } from '../shared/gateway-ctx.ts';
import type { GeminiCountTokensPayload, GeminiGenerateContentPayload } from '@floway-dev/protocols/gemini-generate-content';
import { ProviderModelsUnavailableError, toInternalDebugError } from '@floway-dev/provider';

interface GeminiGenerateContentModelAction {
  readonly model: string;
  readonly action: string;
}

const parseGeminiGenerateContentModelAction = (modelAction: string | undefined): GeminiGenerateContentModelAction | Response => {
  if (modelAction === undefined || modelAction.length === 0) {
    const payload = geminiGenerateContentRpcErrorPayload(404, 'Missing Gemini model action.');
    return Response.json(payload, { status: payload.error.code });
  }
  const separator = modelAction.lastIndexOf(':');
  if (separator <= 0 || separator === modelAction.length - 1) {
    const payload = geminiGenerateContentRpcErrorPayload(404, `Unknown Gemini model action: ${modelAction}`);
    return Response.json(payload, { status: payload.error.code });
  }
  return {
    model: modelAction.slice(0, separator).replace(/^models\//, ''),
    action: modelAction.slice(separator + 1),
  };
};

const parseCountTokensPayload = (body: unknown): GeminiGenerateContentPayload => {
  const shape = body as GeminiCountTokensPayload;
  return shape.generateContentRequest ?? { contents: shape.contents ?? [] };
};

const parseBody = <T>(requestBody: RequestBody, project: (body: unknown) => T): T | Response => {
  try {
    return project(JSON.parse(new TextDecoder().decode(requestBody.bytes)) as unknown);
  } catch (error) {
    const payload = geminiGenerateContentInternalErrorPayload(500, toInternalDebugError(error));
    return Response.json(payload, { status: googleRpcHttpStatusCode(payload.error.code) });
  }
};

const respondWithError = (
  c: AuthedContext,
  error: unknown,
  requestBody: RequestBody,
  ctx: ChatGatewayCtx,
  wantsStream: boolean,
): Response => {
  if (error instanceof ProviderModelsUnavailableError && error.httpResponse !== null) {
    const payload = normalizeGeminiChatFailure({
      type: 'api-error',
      source: 'upstream',
      http: {
        status: error.httpResponse.status,
        headers: Object.freeze([...new Headers(error.httpResponse.headers).entries()].map(([name, value]) => Object.freeze([name, value] as const))),
      },
      body: new TextEncoder().encode(error.httpResponse.body),
    });
    if (payload.type !== 'api-error') throw new Error('Provider model failure must normalize to an api-error outcome');
    const response = chatApiErrorToDownstreamOutcome(payload, {
      ...createChatPipelineServices(ctx),
      runId: '', stageId: 0, stageName: 'geminiGenerateContentHttp',
      signal: ctx.abortSignal ?? new AbortController().signal,
      clock: () => performance.now(), waitUntil: ctx.backgroundScheduler,
      log: { debug() {}, info() {}, warn() {}, error() {} },
      createStream: () => { throw new Error('unreachable'); },
      wrapStream: () => { throw new Error('unreachable'); },
      teeStream: () => { throw new Error('unreachable'); },
      consumeInBackground: () => undefined,
      discard: async () => undefined,
      bind: fn => fn,
      spawnSubRun: async () => { throw new Error('unreachable'); },
    });
    return finalizeGatewayResponse(ctx, new Response(response.body as BodyInit | null, {
      status: response.status,
      headers: new Headers(response.headers.map(([name, value]) => [name, typeof value === 'string' ? value : value.reveal()])),
    }));
  }
  const payload = geminiGenerateContentInternalErrorPayload(500, toInternalDebugError(error));
  void requestBody;
  void wantsStream;
  return finalizeGatewayResponse(ctx, Response.json(payload, { status: 500 }));
};

export const geminiGenerateContentHttp = async (c: AuthedContext): Promise<Response> => {
  const parsed = parseGeminiGenerateContentModelAction(c.req.param('modelAction'));
  if (parsed instanceof Response) return parsed;
  if (parsed.action === 'countTokens') return await runCountTokens(c, parsed.model);
  if (parsed.action === 'generateContent' || parsed.action === 'streamGenerateContent') {
    return await runGenerate(c, parsed.model, parsed.action === 'streamGenerateContent');
  }
  return Response.json(
    geminiGenerateContentRpcErrorPayload(404, `Unknown Gemini model action: ${parsed.action}`),
    { status: 404 },
  );
};

const runGenerate = async (c: AuthedContext, model: string, wantsStream: boolean): Promise<Response> => {
  const requestBody = await readRequestBody(c);
  const payload = parseBody(requestBody, body => body as GeminiGenerateContentPayload);
  if (payload instanceof Response) return payload;
  const inboundHeaders = inboundHeaderEntriesFromHono(c);
  const ctx = createChatGatewayCtxFromHono(c, {
    wantsStream,
    requestBody: takeRequestBody(requestBody),
    model,
    backgroundScheduler: backgroundSchedulerFromContext(c),
  }, apiKey => createNonOpenAIResponsesSourceStore(apiKey.id));
  try {
    const input: GeminiGenerateContentPipelineInput = {
      'request.http': {
        method: c.req.method,
        url: buildDownstreamWireUrl(c.req.url),
        headers: inboundHeaders,
        body: { kind: 'json', value: payload },
        protocol: 'gemini-generate-content',
      },
      'request.inboundHeaders': inboundHeaders,
      'request.model': model,
      'request.payload': payload,
      'request.wantsStream': wantsStream,
    };
    return await runGatewayChatHttpPipeline(c, ctx, geminiGenerateContentPipeline, input, {
      services: createChatPipelineServices(ctx),
    });
  } catch (error) {
    return respondWithError(c, error, requestBody, ctx, wantsStream);
  }
};

const runCountTokens = async (c: AuthedContext, model: string): Promise<Response> => {
  const requestBody = await readRequestBody(c);
  const payload = parseBody(requestBody, parseCountTokensPayload);
  if (payload instanceof Response) return payload;
  const inboundHeaders = inboundHeaderEntriesFromHono(c);
  const ctx = createChatGatewayCtxFromHono(c, {
    wantsStream: false,
    requestBody: takeRequestBody(requestBody),
    model,
    backgroundScheduler: backgroundSchedulerFromContext(c),
  }, apiKey => createNonOpenAIResponsesSourceStore(apiKey.id));
  try {
    const input: GeminiGenerateContentCountTokensPipelineInput = {
      'request.http': {
        method: c.req.method,
        url: buildDownstreamWireUrl(c.req.url),
        headers: inboundHeaders,
        body: { kind: 'json', value: payload },
        protocol: 'gemini-generate-content-count-tokens',
      },
      'request.inboundHeaders': inboundHeaders,
      'request.model': model,
      'request.payload': payload,
    };
    return await runGatewayChatHttpPipeline(c, ctx, geminiGenerateContentCountTokensPipeline, input, {
      services: createChatPipelineServices(ctx),
    });
  } catch (error) {
    return respondWithError(c, error, requestBody, ctx, false);
  }
};
