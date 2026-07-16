// The Claude Code CLI's gateway-discovery model picker (enabled by the
// `CLAUDE_CODE_ENABLE_GATEWAY_MODEL_DISCOVERY=1` env var) applies two
// filters to the `/v1/models` payload before populating its `/model`
// menu:
//
//   models.filter(m => /^(claude|anthropic)/i.test(m.id))
//         .filter(m => { const fam = knownFamily(m.id); return fam === null || fam === fable5Family; })
//
// The second filter drops any id that exact-matches a family string the
// binary already ships built-in (haiku/sonnet/opus/etc.) — discovery is
// meant to advertise EXTRA models beyond the built-in list — with a
// carve-out for the `fable5` family. Extracted verbatim from
// `@anthropic-ai/claude-code@2.1.211`'s compiled `Bootstrap Gateway
// /v1/models` handler, captured 2026-07-16 by grepping the Bun-compiled
// darwin-arm64 binary around the `[Bootstrap] Gateway /v1/models`
// telemetry strings.
//
// Consequences for gateway callers:
//
//  - `label: display_name ?? id` — the picker renders `display_name` to
//    the user; the id itself is only shown on the wire. Rewriting the
//    id is invisible in the UI.
//  - The synthetic prefix used here (`claude-code:`) starts with
//    `claude`, so any non-Anthropic id we advertise passes the first
//    filter. It never exact-matches a built-in family string, so the
//    second filter also passes (`knownFamily('claude-code:gpt-5')`
//    returns null). This mirrors the same de-collision trick that
//    lets `<id>[1m]` variants surface — the bracket suffix guarantees
//    the synthesized id can never coincide with a built-in family
//    string.
//
// The prefix is a Floway-owned convention: `claude-code:` was chosen
// over `claude-` because a bare `claude-` prefix would masquerade a
// non-Anthropic model as a Claude family member in any log / trace /
// error the user sees; the `code:` segment plus the colon separator
// make it visually obvious to anyone reading the wire that the id is
// a gateway alias, not an upstream-native Anthropic name.
export const CLAUDE_CODE_SYNTHETIC_PREFIX = 'claude-code:';

// Ids the CLI's `/^(claude|anthropic)/i` picker filter accepts without
// prefixing. Kept as a single shared regex so `toClaudeCodeShape` (which
// decides whether to prepend) and any future consumer stay in lockstep.
export const CLAUDE_CODE_PICKER_ID_ACCEPT = /^(claude|anthropic)/i;
