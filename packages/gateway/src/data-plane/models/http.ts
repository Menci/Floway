// All OpenAI-compatible model-list paths terminate here. The request path is
// deliberately absent from catalog selection: Codex and Claude Code identify
// their private discovery formats through User-Agent, while every other caller
// receives Floway's public OpenAI/Anthropic superset.

import type { Context } from 'hono';

import { encodeClaudeCodeModelId, isClaudeCodeDiscoveryUserAgent } from './claude-code-prefix.ts';
import { loadModels } from './load.ts';
import { MODEL_LISTING_FAILURE_MESSAGE } from './shared.ts';
import { createPerRequestFetcher } from '../../dial/per-request.ts';
import { effectiveUpstreamIdsFromContext } from '../../middleware/auth.ts';
import { getRepo } from '../../repo/index.ts';
import { backgroundSchedulerFromContext } from '../../runtime/background.ts';
import { getRuntimeLocation } from '../../runtime/runtime-info.ts';
import { isCodexUserAgent } from '../codex/catalog.ts';
import { loadCodexCatalog } from '../codex/models.ts';
import type { PublicModelsResponse } from '@floway-dev/protocols/common';
import { ProviderModelsUnavailableError } from '@floway-dev/provider';

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
// `anthropic-beta: context-1m-2025-08-07`. Native Messages dispatch carries
// that protocol signal independently of ordinary provider header allowlists;
// the suffix remains a discovery-protocol representation of the advertised
// context limit, not a cross-provider header-forwarding policy.
//
// (2) The picker only keeps discovered ids containing `claude` or
// `anthropic` (case-insensitive, anywhere in the string) — Anthropic
// documents this at
// https://code.claude.com/docs/en/llm-gateway-protocol#model-discovery;
// see ./claude-code-prefix.ts for the extracted predicate (kept on the
// stricter begins-with form so one encoding survives both the pre- and
// post-v2.1.223 picker) and the second, built-in-family-collision filter
// it pairs with. Any non-Anthropic model advertised through gateway
// discovery is silently dropped from the menu unless its id carries one
// of those substrings. We prepend `CLAUDE_CODE_SYNTHETIC_PREFIX` on ids
// that don't, so the picker admits them; because the picker renders
// `display_name` (with id as a fallback), the original label the operator
// configured is what the user sees. The Messages entry boundary decodes
// exactly one prefix layer when the same id comes back from a Claude Code
// inference request (`claude-cli/*` or the Claude Desktop app's Electron
// UA), so generic model resolution remains unaware of this client
// compatibility projection.
//
// (3) Mirroring the official shape (instead of the OpenAI-Anthropic
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
  // The CLI's `/model` picker is a chat surface — embedding and image models
  // in the response only clutter the menu. Mirrors the same chat-only narrow
  // already done by the Codex CLI discovery handler at ../codex/models.ts
  // and by `loadGeminiModels` at ./gemini.ts.
  const data = response.data.filter(model => model.kind === 'chat').map(model => {
    const max = model.limits.max_context_window_tokens;
    // Encode the raw id before [1m] is appended, so the CLI's suffix strip
    // lands on exactly the reversible discovery id.
    const encoded = encodeClaudeCodeModelId(model.id);
    return {
      id: max !== undefined && max >= 1_000_000 ? `${encoded}[1m]` : encoded,
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

export const serveModels = async (c: Context): Promise<Response> => {
  try {
    const userAgent = c.req.header('user-agent');
    const fetcherForUpstream = await createPerRequestFetcher(getRuntimeLocation(c.req.raw));
    const upstreamIds = effectiveUpstreamIdsFromContext(c);
    const scheduler = backgroundSchedulerFromContext(c);

    if (isCodexUserAgent(userAgent)) {
      return Response.json(await loadCodexCatalog(userAgent, upstreamIds, fetcherForUpstream, scheduler));
    }

    const publicCatalog = await loadModels(upstreamIds, fetcherForUpstream, scheduler, getRepo().modelAliases);
    // The Claude Code model discovery request identifies itself with a
    // `claude-code/<version>` User-Agent (built from the CLI's `n_()`
    // helper — verified in the v2.1.206 binary). The Claude Desktop app
    // embeds the same picker but sends an Electron `Mozilla/5.0 …
    // Claude/<version> …` UA; isClaudeCodeDiscoveryUserAgent admits both.
    // The CLI's inference paths use the Anthropic SDK's `claude-cli/*` UA,
    // so match on the discovery UA specifically. Every other caller
    // (OpenAI SDKs, Anthropic SDKs, dashboards) receives the standard
    // PublicModel superset.
    return Response.json(isClaudeCodeDiscoveryUserAgent(userAgent)
      ? toClaudeCodeCatalog(publicCatalog)
      : publicCatalog);
  } catch (e) {
    // Upstream HTTP/parse failures squash to a generic message so we do not
    // leak upstream identity. Other registry-thrown errors (e.g. the "no
    // upstream configured" hint) carry actionable operator guidance and
    // surface verbatim with the same 502.
    const message = e instanceof ProviderModelsUnavailableError
      ? MODEL_LISTING_FAILURE_MESSAGE
      : (e instanceof Error ? e.message : String(e));
    return Response.json({ error: { message, type: 'api_error' } }, { status: 502 });
  }
};
