// OpenAI and Anthropic /models field names do not overlap, so one payload
// satisfies both client shapes. The one exception is the Claude Code CLI
// discovery caller — see toClaudeCodeShape below.

import type { Context } from 'hono';

import { CLAUDE_CODE_PICKER_ID_ACCEPT, CLAUDE_CODE_SYNTHETIC_PREFIX } from './claude-code-prefix.ts';
import { loadModels } from './load.ts';
import { MODEL_LISTING_FAILURE_MESSAGE } from './shared.ts';
import { createPerRequestFetcher } from '../../dial/per-request.ts';
import { effectiveUpstreamIdsFromContext } from '../../middleware/auth.ts';
import { getRepo } from '../../repo/index.ts';
import { backgroundSchedulerFromContext } from '../../runtime/background.ts';
import { getRuntimeLocation } from '../../runtime/runtime-info.ts';
import type { PublicModelsResponse } from '@floway-dev/protocols/common';
import { ProviderModelsUnavailableError } from '@floway-dev/provider';

// Anthropic's official /v1/models shape — `{data, first_id, has_more,
// last_id}` with `ModelInfo` rows — served to Claude Code CLI's `/model`
// picker. Three picker mechanics dictate the fields below.
//
// (1) The CLI's `[1m]` suffix convention — append `[1m]` to a model id and
// the CLI switches that pick to the 1M-context window — only reaches the
// picker when the discovered id itself carries the suffix; the CLI does
// not synthesize the variant on discovered ids in gateway mode. So we
// rewrite the id of every 1M-capable model on the wire. Provider-side
// routing is unaffected: the CLI strips `[1m]` before every inference
// request and pairs it with `anthropic-beta: context-1m-2025-08-07`,
// which providers already honor (Copilot's `context1m` variant selector;
// Claude Code passes it through to the upstream).
//
// (2) The picker only accepts discovered ids matching
// `/^(claude|anthropic)/i` (see ./claude-code-prefix.ts for the extracted
// predicate). Any non-Anthropic model advertised through gateway
// discovery is silently dropped from the menu unless its id starts with
// one of those two prefixes. We prepend `CLAUDE_CODE_SYNTHETIC_PREFIX`
// on those ids so the picker admits them; because the picker renders
// `display_name` (with id as a fallback), the original label the
// operator configured is what the user sees. The prefix is stripped
// back off in `enumerateModelCandidates` when the same id comes in on
// `/v1/messages` (or any other data-plane endpoint) so routing lands on
// the real model.
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
const toClaudeCodeShape = (response: PublicModelsResponse) => {
  const CREATED_AT_UNKNOWN = '1970-01-01T00:00:00Z';
  // The CLI's `/model` picker is a chat surface — embedding and image models
  // in the response only clutter the menu. Mirrors the same chat-only narrow
  // already done by the Codex CLI discovery handler at ../codex/models.ts
  // and by `loadGeminiModels` at ./gemini.ts.
  const data = response.data.filter(model => model.kind === 'chat').map(model => {
    const max = model.limits.max_context_window_tokens;
    // Prefix decision runs on the raw id (so a real `claude-*` never gets
    // double-prefixed), then [1m] is appended to the possibly-prefixed
    // form so the CLI's suffix strip lands cleanly on either shape.
    const accepted = CLAUDE_CODE_PICKER_ID_ACCEPT.test(model.id);
    const withPrefix = accepted ? model.id : `${CLAUDE_CODE_SYNTHETIC_PREFIX}${model.id}`;
    const withSuffix = max !== undefined && max >= 1_000_000 ? `${withPrefix}[1m]` : withPrefix;
    return {
      id: withSuffix,
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

export const models = async (c: Context) => {
  try {
    const fetcherForUpstream = await createPerRequestFetcher(getRuntimeLocation(c.req.raw));
    const response = await loadModels(effectiveUpstreamIdsFromContext(c), fetcherForUpstream, backgroundSchedulerFromContext(c), getRepo().modelAliases);
    // The Claude Code CLI's model discovery request identifies itself with
    // a `claude-code/<version>` User-Agent (built from the CLI's `n_()`
    // helper — verified in the v2.1.206 binary). The CLI's other request
    // paths use the Anthropic SDK's `claude-cli/*` UA, so match on the
    // discovery UA specifically. Every other caller (OpenAI SDKs,
    // Anthropic SDKs, dashboards) receives the standard PublicModel
    // superset.
    if (c.req.header('user-agent')?.startsWith('claude-code/')) {
      return Response.json(toClaudeCodeShape(response));
    }
    return Response.json(response);
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
