// POST /alpha/search, served through the pipeline.
//
// What the handler decides before the run is which ending the chain gets: the operator's
// `passthroughOpenAiSearch` setting pins an upstream, and everything else runs the commands
// here. That is a property of configuration rather than of the request, so it is read once and
// the chain is assembled around it — which is why the family has one pipeline builder rather
// than a stage that branches.
//
// The configured search backend reaches the chain as a service and never as a fact: it holds
// live handles built from the operator's provider credential, so none of it is dumpable and
// none of it belongs in the record.

import type { Context } from 'hono';

import { searchServePipeline, type SearchExecution, type SearchServices } from './pipeline.ts';
import { alphaSearchRequestSchema, type AlphaSearchRequest } from './protocol.ts';
import type { AuthedContext } from '../../middleware/auth.ts';
import { openPrologue, readIngress, serveThrough, type Prologue } from '../pipeline/serve.ts';
import { finalizeGatewayResponse } from '../shared/gateway-ctx.ts';
import { loadWebSearchConfig } from '../tools/web-search/config.ts';
import { resolveConfiguredWebSearchProvider } from '../tools/web-search/provider.ts';
import type { ConfiguredWebSearchProvider, WebSearchConfig } from '../tools/web-search/types.ts';
import { move } from '@floway-dev/pipeline';

/** Which ending this gateway's configuration asks for. The word "passthrough" is about whose
 *  search results the client is given, not about carrying a protocol the gateway has not
 *  parsed — what comes back is read and written again either way. */
const executionFor = (config: WebSearchConfig): SearchExecution =>
  config.passthroughOpenAiSearch.enabled
    ? { kind: 'upstream', upstreamId: config.passthroughOpenAiSearch.upstreamId, model: config.passthroughOpenAiSearch.model }
    : { kind: 'local' };

/** Resolved once per turn and shared by every operation in it: one turn's commands run against
 *  one backend, and resolving per operation would build the same handles again. */
const searchProviderFor = (config: WebSearchConfig): SearchServices['searchProvider'] => {
  let resolved: Promise<ConfiguredWebSearchProvider> | undefined;
  return () => {
    resolved ??= Promise.resolve(resolveConfiguredWebSearchProvider(config));
    return resolved;
  };
};

/** The request as this protocol, or the sentence saying why it is not. The family reads its own
 *  body because the run is given the bytes the client sent, and a validator middleware would
 *  have consumed them first. */
type Read = { readonly ok: true; readonly request: AlphaSearchRequest } | { readonly ok: false; readonly message: string };

const readAlphaSearchRequest = (bytes: Uint8Array): Read => {
  let body: unknown;
  try {
    body = JSON.parse(new TextDecoder().decode(bytes)) as unknown;
  } catch (error) {
    return { ok: false, message: error instanceof Error ? error.message : String(error) };
  }
  const parsed = alphaSearchRequestSchema.safeParse(body);
  // The first issue's message, verbatim: a schema attaches a field-aware message where it wants
  // one, and prepending the path would name the field twice.
  return parsed.success
    ? { ok: true, request: parsed.data }
    : { ok: false, message: parsed.error.issues[0]?.message ?? 'Invalid input' };
};

export const alphaSearch = async (c: Context): Promise<Response> => {
  const ingress = await readIngress(c);
  const read = readAlphaSearchRequest(ingress.body.bytes);
  if (!read.ok) {
    // A request the gateway could not read never reaches a pipeline: there is no backend to
    // reach and no attempt to make, so there is nothing for a run to record.
    const refused = openPrologue(c as AuthedContext, ingress, { wantsStream: false });
    refused.gateway.dump?.error('gateway');
    return finalizeGatewayResponse(refused.gateway, Response.json({ error: read.message }, { status: 400 }));
  }

  const config = await loadWebSearchConfig();
  const execution = executionFor(config);
  // A pinned turn is attributed to the model the operator pinned, because that is the one that
  // will be called: the id the caller sent names a model of its own that never travels.
  const prologue = openPrologue(c as AuthedContext, ingress, {
    wantsStream: false,
    ...(execution.kind === 'upstream' ? { model: execution.model } : {}),
  });
  const services: SearchServices = { ...prologue.services, searchProvider: searchProviderFor(config) };
  const withBackend: Prologue = { ...prologue, services };

  return await serveThrough(
    c,
    withBackend,
    searchServePipeline(execution),
    move({
      'ingress.http.headers': prologue.headers,
      'request.search.alphaSearch': read.request,
    }) as never,
    facts => ({ body: JSON.stringify(facts['response.search.rendered']), contentType: 'application/json' }),
  );
};
