// OpenAI and Anthropic /models field names do not overlap, so one payload
// satisfies both client shapes. The one exception is the Claude Code CLI
// discovery caller — see toClaudeCodeShape below.

import type { Context } from 'hono';

import { loadModels } from './load.ts';
import { MODEL_LISTING_FAILURE_MESSAGE } from './shared.ts';
import { createPerRequestFetcher } from '../../dial/per-request.ts';
import { effectiveUpstreamIdsFromContext } from '../../middleware/auth.ts';
import { getRepo } from '../../repo/index.ts';
import { backgroundSchedulerFromContext } from '../../runtime/background.ts';
import { getCurrentColo } from '../../runtime/runtime-info.ts';
import type { PublicModelsResponse } from '@floway-dev/protocols/common';
import { ProviderModelsUnavailableError } from '@floway-dev/provider';

// Claude Code CLI's `/model` picker discovers gateway-served models by GET
// /v1/models?limit=1000, reads only `id` (+ optional `display_name`), and
// adds each entry as-is. Two picker mechanics dictate the shape below.
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
// (2) The response follows Anthropic's official /v1/models shape —
// `{data, first_id, has_more, last_id}` with `ModelInfo` rows — instead
// of the OpenAI-Anthropic superset. Other Anthropic-format callers
// parse the same official shape, so mirroring it here also lets any
// future Anthropic-native picker reuse the payload. `capabilities` is
// nullable per the SDK type; we do not track every dimension the SDK
// declares (batch, citations, code_execution, pdf_input,
// structured_outputs), so returning null is honest — contrast with
// fabricating {supported: false} rows for features we do not observe.
// CLI-side the whole object is `.strip()`ed away regardless.
//
// https://code.claude.com/docs/en/llm-gateway-protocol#model-discovery
// https://docs.claude.com/en/api/models-list
// https://github.com/anthropics/anthropic-sdk-typescript/blob/main/src/resources/models.ts
const toClaudeCodeShape = (response: PublicModelsResponse, userAgent: string | undefined) => {
  if (!userAgent?.startsWith('claude-cli/')) return response;
  // Anthropic requires `created_at` on every row, but not every catalog
  // (Copilot, custom upstreams) declares one. Epoch is the least-lossy
  // sentinel — never confuseable with a real release date and stable
  // across catalog fetches.
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

export const models = async (c: Context) => {
  try {
    const fetcherForUpstream = await createPerRequestFetcher(getCurrentColo(c.req.raw));
    const response = await loadModels(effectiveUpstreamIdsFromContext(c), fetcherForUpstream, backgroundSchedulerFromContext(c), getRepo().modelAliases);
    return Response.json(toClaudeCodeShape(response, c.req.header('user-agent')));
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
