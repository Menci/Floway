// All OpenAI-compatible model-list paths terminate here. The request path is
// deliberately absent from catalog selection: Codex, Claude Code, Pi, and OMP identify
// their private discovery formats through User-Agent, while every other caller
// receives Floway's public OpenAI/Anthropic superset.

import type { Context } from 'hono';

import { loadModels } from './load.ts';
import { isOmpUserAgent, toOmpCatalog } from './omp-catalog.ts';
import { createModelsRefreshScheduler } from '../../execution/models-refresh.ts';
import { effectiveUpstreamIdsFromContext } from '../../middleware/auth.ts';
import { getRepo } from '../../repo/index.ts';
import { backgroundSchedulerFromContext } from '../../runtime/background.ts';
import { getRuntimeLocation } from '../../runtime/runtime-info.ts';
import { isCodexUserAgent } from '../codex/catalog.ts';
import { loadCodexCatalog } from '../codex/models.ts';
import { isPiUserAgent, toPiCatalog } from '../pi/catalog.ts';
import { agentSetupProviderSchema, InvalidAgentSetupEndpointError, normalizeAgentSetupEndpoint } from '@floway-dev/agent-setup';
import type { PublicModelsResponse } from '@floway-dev/protocols/common';
import { toInternalDebugError } from '@floway-dev/provider';

// Anthropic's official /v1/models shape — `{data, first_id, has_more,
// last_id}` with `ModelInfo` rows — served to Claude Code CLI's `/model`
// picker. Two picker mechanics dictate the fields below.
//
// (1) The CLI's `[1m]` suffix convention — append `[1m]` to a model id and
// the CLI switches that pick to the 1M-context window — only reaches the
// picker when the discovered id itself carries the suffix; the CLI does
// not synthesize the variant on discovered ids in gateway mode. So we
// rewrite the id of every 1M-capable model on the wire. On inference, the CLI
// strips `[1m]` from the model id and pairs the request with
// `anthropic-beta: context-1m-2025-08-07`. Native Anthropic Messages dispatch carries
// that protocol signal independently of ordinary provider header allowlists;
// the suffix remains a discovery-protocol representation of the advertised
// context limit, not a cross-provider header-forwarding policy.
//
// (2) Mirroring the official shape (instead of the OpenAI-Anthropic
// superset the handler serves everyone else) also lets any future
// Anthropic-native picker consume the payload verbatim. `capabilities`
// is nullable per the SDK type; we do not track every dimension the
// SDK declares (batch, citations, code_execution, pdf_input,
// structured_outputs), so returning null is honest — contrast with
// fabricating {supported: false} rows for features we do not observe.
// CLI-side the whole object is `.strip()`ed away regardless. Similarly,
// `created_at` falls back to the epoch when the upstream never declared
// one — the least-lossy sentinel, never confuseable with a real release
// date and stable across catalog fetches.
//
// https://code.claude.com/docs/en/llm-gateway-protocol#model-discovery
// https://docs.claude.com/en/api/models-list
// https://github.com/anthropics/anthropic-sdk-typescript/blob/main/src/resources/models.ts
const toClaudeCodeCatalog = (response: PublicModelsResponse) => {
  const CREATED_AT_UNKNOWN = '1970-01-01T00:00:00Z';
  const data = response.data.map(model => {
    const max = model.limits.max_context_window_tokens;
    return {
      id: max !== undefined && max >= 1_000_000 ? `${model.id}[1m]` : model.id,
      type: 'model' as const,
      display_name: model.display_name,
      created_at: model.created_at ?? CREATED_AT_UNKNOWN,
      max_input_tokens: max ?? null,
      max_tokens: model.limits.max_output_tokens ?? null,
      capabilities: null,
    };
  });
  return {
    data,
    first_id: data[0]?.id ?? null,
    has_more: false as const,
    last_id: data[data.length - 1]?.id ?? null,
  };
};

const isClaudeCodeUserAgent = (userAgent: string | undefined): boolean =>
  userAgent?.startsWith('claude-code/') ?? false;

export const serveModels = async (c: Context): Promise<Response> => {
  try {
    const userAgent = c.req.header('user-agent');
    const suppliedEndpoint = (isPiUserAgent(userAgent) || isOmpUserAgent(userAgent)) ? c.req.query('endpoint') : undefined;
    // We use the configured public endpoint so reverse-proxy Host rewrites
    // cannot redirect native inference to an internal origin.
    const configuredEndpoint = suppliedEndpoint === undefined ? undefined : normalizeAgentSetupEndpoint(suppliedEndpoint);
    const suppliedProvider = (isPiUserAgent(userAgent) || isOmpUserAgent(userAgent)) ? c.req.query('provider') : undefined;
    const providerResult = agentSetupProviderSchema.safeParse(suppliedProvider ?? 'floway');
    if (!providerResult.success) return Response.json({ error: { type: 'invalid_request_error', message: 'Invalid provider identifier' } }, { status: 400 });
    const provider = providerResult.data;
    const runtimeLocation = getRuntimeLocation(c.req.raw);
    const upstreamIds = effectiveUpstreamIdsFromContext(c);
    const scheduleRefresh = createModelsRefreshScheduler(runtimeLocation, backgroundSchedulerFromContext(c));

    if (isCodexUserAgent(userAgent)) {
      return Response.json(await loadCodexCatalog(userAgent, upstreamIds, scheduleRefresh));
    }

    const publicCatalog = await loadModels(upstreamIds, scheduleRefresh, getRepo().modelAliases);
    if (isPiUserAgent(userAgent)) {
      const endpoint = new URL(c.req.url);
      endpoint.search = '';
      endpoint.pathname = endpoint.pathname.replace(/\/(?:v1\/)?models$/, '/v1');
      const baseUrl = configuredEndpoint !== undefined ? `${configuredEndpoint}/v1` : endpoint.toString().replace(/\/$/, '');
      return Response.json(toPiCatalog(publicCatalog.data, baseUrl, provider));
    }

    if (isOmpUserAgent(userAgent)) {
      const url = new URL(c.req.url);
      const root = url.pathname.replace(/\/(?:v1\/)?models$/, '');
      return Response.json(toOmpCatalog(publicCatalog, configuredEndpoint ?? `${url.origin}${root}`, provider));
    }

    // The Claude Code CLI's model discovery request identifies itself with
    // a `claude-code/<version>` User-Agent (built from the CLI's `n_()`
    // helper — verified in the v2.1.206 binary). The CLI's other request
    // paths use the Anthropic SDK's `claude-cli/*` UA, so match on the
    // discovery UA specifically. Every other caller (OpenAI SDKs,
    // Anthropic SDKs, dashboards) receives the standard PublicModel
    // superset.
    return Response.json(isClaudeCodeUserAgent(userAgent)
      ? toClaudeCodeCatalog(publicCatalog)
      : publicCatalog);
  } catch (e) {
    if (e instanceof InvalidAgentSetupEndpointError) {
      return Response.json({ error: { message: e.message, type: 'invalid_request_error' } }, { status: 400 });
    }
    if (isPiUserAgent(c.req.header('user-agent')) || isOmpUserAgent(c.req.header('user-agent'))) return Response.json({ error: toInternalDebugError(e) }, { status: 502 });
    const message = e instanceof Error ? e.message : String(e);
    return Response.json({ error: { message, type: 'api_error' } }, { status: 502 });
  }
};
