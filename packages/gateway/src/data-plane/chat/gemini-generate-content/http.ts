// `/v1beta/models/:modelAction`, whose three actions are each served through a pipeline.
// `:generateContent` and `:streamGenerateContent` are one chain; `:countTokens` is a second
// operation over the same protocol and is a chain of its own rather than another wire under
// the first.
//
// Each entry is a prologue and an epilogue around that chain: read what the client sent, hand
// it over, and turn what the run answered with into a response. Everything between is stages.

import { geminiGenerateContentCountTokensPipeline } from './count-tokens.ts';
import { renderGeminiGenerateContentError } from './errors.ts';
import { geminiGenerateContentServePipeline } from './pipeline.ts';
import type { AuthedContext } from '../../../middleware/auth.ts';
import { isFrames, openPrologue, readIngress, serveThrough, type Ingress } from '../../pipeline/serve.ts';
import { finalizeGatewayResponse } from '../../shared/gateway-ctx.ts';
import { openChatPrologue } from '../prologue.ts';
import { createNonOpenAIResponsesSourceStore } from '../openai-responses/items/store.ts';
import { move } from '@floway-dev/pipeline';
import type { GeminiGenerateContentContent, GeminiGenerateContentPayload } from '@floway-dev/protocols/gemini-generate-content';

interface GeminiGenerateContentModelAction {
  readonly model: string;
  readonly action: string;
}

// The Gemini wire API encodes both the model id and the action in one path
// segment (e.g. `models/gemini-2.5-pro:streamGenerateContent`). The Hono route
// captures everything after `/v1beta/models/` in a single `modelAction` param;
// we split on the trailing `:` here so each entry sees just the action and
// the resolved model id (with a leading `models/` prefix tolerated, as Google
// SDKs send it).
/** A refusal about the route itself. It is answered before a model is resolved, so there is no
 *  attempt to record and nothing for a run to hold beyond the refusal. */
const unknownAction = (message: string): Response => Response.json(renderGeminiGenerateContentError(404, message), { status: 404 });

const parseGeminiGenerateContentModelAction = (modelAction: string | undefined): GeminiGenerateContentModelAction | Response => {
  if (!modelAction) return unknownAction('Missing Gemini model action.');
  const separator = modelAction.lastIndexOf(':');
  if (separator <= 0 || separator === modelAction.length - 1) return unknownAction(`Unknown Gemini model action: ${modelAction}`);
  return { model: modelAction.slice(0, separator).replace(/^models\//, ''), action: modelAction.slice(separator + 1) };
};

// `:countTokens` can carry either `contents` directly or a nested
// `generateContentRequest` envelope (Google's SDK shape). Normalize both to a
// single `GeminiGenerateContentPayload` for the rest of the chain.
const parseGeminiGenerateContentCountTokensPayload = (body: unknown): GeminiGenerateContentPayload => {
  const shape = (body ?? {}) as { contents?: GeminiGenerateContentContent[]; generateContentRequest?: GeminiGenerateContentPayload };
  return shape.generateContentRequest ?? { contents: shape.contents };
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
  return unknownAction(`Unknown Gemini model action: ${parsed.action}`);
};

/** A body the gateway could not read is reported in the words this protocol's own clients
 *  parse, rather than as a fault of the gateway's. Each action reads the same bytes into its
 *  own shape, which is why the projection is the caller's. */
const readRequest = <T>(bytes: Uint8Array, project: (body: unknown) => T): { type: 'ok'; payload: T } | { type: 'invalid'; message: string } => {
  try {
    return { type: 'ok', payload: project(JSON.parse(new TextDecoder().decode(bytes)) as unknown) };
  } catch (error) {
    return { type: 'invalid', message: error instanceof Error ? error.message : String(error) };
  }
};

/** A request the gateway refused before it reached a pipeline: there is no model to resolve
 *  and no attempt to make, so there is nothing for a run to record beyond the refusal. */
const refuse = (c: AuthedContext, ingress: Ingress, message: string): Response => {
  const refused = openPrologue(c, ingress, { wantsStream: false });
  refused.gateway.dump?.error('gateway');
  return finalizeGatewayResponse(refused.gateway, Response.json(renderGeminiGenerateContentError(400, message), { status: 400 }));
};

const runGeminiGenerateContentGenerate = async (c: AuthedContext, model: string, wantsStream: boolean): Promise<Response> => {
  const ingress = await readIngress(c);
  const request = readRequest(ingress.body.bytes, (body): GeminiGenerateContentPayload => body as GeminiGenerateContentPayload);
  if (request.type === 'invalid') return refuse(c, ingress, request.message);

  const { payload } = request;
  const prologue = openChatPrologue(c, ingress, {
    wantsStream,
    model,
    storeFactory: apiKey => createNonOpenAIResponsesSourceStore(apiKey.id),
  });

  return await serveThrough(
    c,
    prologue,
    geminiGenerateContentServePipeline(payload),
    move({
      'ingress.http.headers': prologue.headers,
      'ingress.chat.sourceProtocol': 'geminiGenerateContent',
      'ingress.chat.geminiGenerateContent.wantsStream': wantsStream,
      'request.chat.geminiGenerateContent': payload,
      // Gemini carries the model in the path rather than the body, so the id the run
      // resolves against is the one the route split off.
      'serve.model': model,
    }) as never,
    facts => {
      const rendered = facts['response.chat.geminiGenerateContent.rendered'];
      if (isFrames(rendered)) return { frames: rendered };
      return { body: JSON.stringify(rendered), contentType: 'application/json' };
    },
    facts => facts['response.chat.geminiGenerateContent.streamedUsage'],
  );
};

const runGeminiGenerateContentCountTokens = async (c: AuthedContext, model: string): Promise<Response> => {
  const ingress = await readIngress(c);
  const request = readRequest(ingress.body.bytes, parseGeminiGenerateContentCountTokensPayload);
  if (request.type === 'invalid') return refuse(c, ingress, request.message);

  const { payload } = request;
  const prologue = openChatPrologue(c, ingress, {
    wantsStream: false,
    model,
    storeFactory: apiKey => createNonOpenAIResponsesSourceStore(apiKey.id),
  });

  return await serveThrough(
    c,
    prologue,
    geminiGenerateContentCountTokensPipeline(payload),
    move({
      'ingress.http.headers': prologue.headers,
      'ingress.chat.sourceProtocol': 'geminiGenerateContent',
      'request.chat.geminiGenerateContent': payload,
      'serve.model': model,
    }) as never,
    // A measurement is one body however the turn went, so there is never a stream to write.
    facts => ({ body: JSON.stringify(facts['response.chat.geminiGenerateContent.rendered']), contentType: 'application/json' }),
  );
};
