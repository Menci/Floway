import { withRoleCompatibilityApplied } from './apply-role-compatibility.ts';
import { withResponsesCompactShim } from './compact-shim.ts';
import { withReasoningDisabledOnForcedToolChoice } from './disable-reasoning-on-forced-tool-choice.ts';
import { withExclusiveCachedTokensNormalized } from './normalize-exclusive-cached-tokens.ts';
import { withResponsesServerToolShim } from './server-tool-shim.ts';
import { imageGenerationServerTool } from './server-tools/image-generation.ts';
import { webSearchServerTool } from './server-tools/web-search.ts';
import { withPromptCacheKeyStripped } from './strip-prompt-cache-key.ts';
import type { ResponsesInterceptor } from './types.ts';
import { withVendorDeepSeekResponsesNormalize } from './vendor-deepseek-normalize.ts';
import { withVendorQwenResponsesNormalize } from './vendor-qwen-normalize.ts';

// Unified Responses interceptor list. All entries are attached to every
// candidate; each interceptor's body decides whether to act (flag-gated entries
// early-return on `providerModelOf(ctx.candidate).enabledFlags.has(flagId)`).
//
// Translated requests re-enter the selected target protocol's chain. The role
// compatibility entry therefore acts only when Responses is the final target,
// after pairwise translation has finished.
//
// Order matters: earlier entries wrap later ones.
//   - withResponsesCompactShim: runs outermost so the action pivot
//     ('compact' → 'generate' for the inner summarization turn) is visible
//     to every downstream interceptor + the provider terminal. Also
//     responsible for inbound expansion of prior shim-encoded compaction
//     items so the upstream sees the summarized history.
//   - withResponsesServerToolShim: wraps the multi-turn ReAct loop around
//     the rest of the chain.
//   - withReasoningDisabledOnForcedToolChoice: gated by
//     `disable-reasoning-on-forced-tool-choice`.
//   - withRoleCompatibilityApplied: applies role flags in the fixed order
//     `system → developer → system → user`; later rewrites are authoritative
//     when flags overlap, and the final step affects only mid-conversation system.
//   - withPromptCacheKeyStripped: gated by `strip-prompt-cache-key`. Drops
//     the top-level `prompt_cache_key` field for upstreams that reject it
//     as an unknown argument (e.g. Azure DeepSeek). Runs before vendor
//     normalizers so vendor-specific translation sees the already-stripped
//     canonical payload.
//   - withExclusiveCachedTokensNormalized: unconditional on a Responses
//     target. Folds the cache buckets back into `input_tokens` whenever
//     `total_tokens` witnesses that the upstream reports them alongside it,
//     and consults `usage-exclusive-cached-tokens` for the responses whose
//     totals witness nothing — so the flag is a declaration input rather than
//     a gate.
//   - withVendor*ResponsesNormalize: gated by `vendor-<X>`. Registered after
//     the role-compatibility entry so each gets the final say on the outbound wire
//     body.
export const responsesInterceptors: readonly ResponsesInterceptor[] = [
  withResponsesCompactShim,
  withResponsesServerToolShim([
    webSearchServerTool,
    imageGenerationServerTool,
  ]),
  withReasoningDisabledOnForcedToolChoice,
  withRoleCompatibilityApplied,
  withPromptCacheKeyStripped,
  withExclusiveCachedTokensNormalized,
  withVendorDeepSeekResponsesNormalize,
  withVendorQwenResponsesNormalize,
];
