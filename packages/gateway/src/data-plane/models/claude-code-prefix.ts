// The Claude Code CLI's gateway-discovery model picker (enabled by the
// `CLAUDE_CODE_ENABLE_GATEWAY_MODEL_DISCOVERY=1` env var) applies two
// filters to the `/v1/models` payload before populating its `/model`
// menu. Anthropic documents both filters at
// https://code.claude.com/docs/en/llm-gateway-protocol#model-discovery:
//
//   > Claude Code reads `id` and the optional `display_name` from each
//   > entry in the response's `data` array, and ignores entries whose
//   > `id` doesn't begin with `claude` or `anthropic`.
//
//   > A discovered ID is skipped when it exactly matches a row already
//   > in the picker, or when both the discovered and existing IDs
//   > resolve to Fable.
//
// The compiled implementation matches the docs verbatim; the shape is
//
//   models.filter(m => /^(claude|anthropic)/i.test(m.id))
//         .filter(m => { const fam = knownFamily(m.id); return fam === null || fam === fable5Family; })
//
// where `knownFamily` walks the CLI's built-in id→family map. Extracted
// from `@anthropic-ai/claude-code@2.1.211`'s compiled `Bootstrap Gateway
// /v1/models` handler, captured 2026-07-16 by grepping the Bun-compiled
// darwin-arm64 binary around the `[Bootstrap] Gateway /v1/models`
// telemetry strings; the docs are the primary source-of-truth and the
// binary extraction pins the exact carve-out (`fable5`) and evaluation
// order the prose leaves implicit.
//
// Consequences for gateway callers:
//
//  - `label: display_name ?? id` — the picker renders `display_name` to
//    the user; the id itself is only shown on the wire. Rewriting the
//    id is invisible in the UI.
//  - `claude-code!` passes the first filter and never exact-matches a
//    built-in family string, so prefixed non-Anthropic ids survive both
//    filters without masquerading as an upstream-native Claude family.
//  - The prefix is an encoding marker, not a reserved model-id namespace.
//    Floway model ids are opaque, so discovery also prefixes a raw id that
//    already begins with the marker. This prefix-doubling makes the mapping
//    injective: M, P+M, and P+P+M become P+M, P+P+M, and P+P+P+M.
export const CLAUDE_CODE_SYNTHETIC_PREFIX = 'claude-code!';

// Ids the CLI's `/^(claude|anthropic)/i` picker filter accepts without
// prefixing. Kept next to the encoder so the accept and escape decisions
// cannot drift apart.
export const CLAUDE_CODE_PICKER_ID_ACCEPT = /^(claude|anthropic)/i;

export const encodeClaudeCodeModelId = (modelId: string): string =>
  CLAUDE_CODE_PICKER_ID_ACCEPT.test(modelId)
  && !modelId.startsWith(CLAUDE_CODE_SYNTHETIC_PREFIX)
    ? modelId
    : `${CLAUDE_CODE_SYNTHETIC_PREFIX}${modelId}`;

// Claude Code inference requests use the Anthropic SDK's `claude-cli/*`
// User-Agent rather than the `claude-code/*` discovery identity. The same
// leading product token is part of the real-client detector documented at
// https://github.com/Wei-Shaw/sub2api/blob/4a5665da5b2c6b83c4597844ea6e573746c821b1/backend/internal/service/claude_code_validator.go
// Decode exactly one layer before Messages model resolution; other clients'
// opaque ids must pass through untouched.
export const decodeClaudeCodeModelId = (
  modelId: string,
  userAgent: string | undefined,
): string =>
  userAgent?.startsWith('claude-cli/') === true
  && modelId.startsWith(CLAUDE_CODE_SYNTHETIC_PREFIX)
    ? modelId.slice(CLAUDE_CODE_SYNTHETIC_PREFIX.length)
    : modelId;
