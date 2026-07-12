// Desugar the gpt-5.4+ Responses API tool_search feature family into a legacy
// tools[]-only shape before dispatch. Always-attached; flag-gated by
// `flatten-tool-search-family`.
//
// The family features are correlated (all released together as one bundle and
// depend on each other): implementing this flag as a single one-pass rewrite
// matches every real upstream population — either the endpoint supports the
// whole family (leave verbatim, flag off) or it supports none of it (desugar
// the entire family in one place, flag on).
//
// Outbound (request → upstream):
//
// 1. Every `type: 'additional_tools'` input item is removed; its inner
//    `tools[]` is appended to the top-level `payload.tools[]`.
// 2. Every `type: 'namespace'` container in the resulting `payload.tools[]`
//    is unpacked into its nested sub-tools (via `unpackNamespaceTools`,
//    which also prefixes each sub-tool's `name` with `<namespace>__` to
//    preserve grouping semantic — see `withUnprefixNamespaceToolCalls` for
//    the response-side inverse).
// 3. Every remaining `type: 'tool_search'` or `type: 'programmatic_tool_calling'`
//    hosted-tool entry is dropped from `payload.tools[]`.
// 4. Every remaining `function`/`custom` tool has its `defer_loading` and
//    `allowed_callers` fields stripped (they have no meaning without
//    `tool_search` / PTC).
//
// Inbound: nothing — see `withUnprefixNamespaceToolCalls` for the response-side
// pair that undoes the namespace-name prefix on tool-call outputs.
//
// Ref: https://developers.openai.com/api/docs/guides/tools-tool-search

import type { ResponsesInterceptor } from './types.ts';
import { flattenToolSearchFamilyTools, type ResponsesInputItem, type ResponsesTool } from '@floway-dev/protocols/responses';
import { providerModelOf } from '@floway-dev/provider';

export const withFlattenToolSearchFamily: ResponsesInterceptor = async (ctx, _request, run) => {
  if (!providerModelOf(ctx.candidate).enabledFlags.has('flatten-tool-search-family')) return await run();

  const originalInput = ctx.payload.input;
  const extracted: ResponsesTool[] = [];
  const remainingInput: ResponsesInputItem[] = [];
  for (const item of originalInput) {
    if (item.type === 'additional_tools') {
      const inner = (item as { tools?: unknown }).tools;
      if (Array.isArray(inner)) extracted.push(...(inner as ResponsesTool[]));
      continue;
    }
    remainingInput.push(item);
  }

  const originalTools = ctx.payload.tools ?? null;
  const merged = extracted.length > 0
    ? [...(originalTools ?? []), ...extracted]
    : (originalTools ?? []);
  const flat = merged.length > 0 ? flattenToolSearchFamilyTools(merged) : [];

  const inputChanged = remainingInput.length !== originalInput.length;
  // Reference-equality on the array + members catches "identical shape" — if
  // no member differs and the length matches the original tools list, the
  // rewrite would be a no-op.
  const toolsChanged =
    (originalTools === null && flat.length > 0)
    || (originalTools !== null && (flat.length !== originalTools.length || flat.some((t, i) => t !== originalTools[i])));

  if (!inputChanged && !toolsChanged) return await run();

  ctx.payload = {
    ...ctx.payload,
    ...(inputChanged ? { input: remainingInput } : {}),
    ...(toolsChanged ? { tools: flat.length > 0 ? flat : null } : {}),
  };
  return await run();
};
