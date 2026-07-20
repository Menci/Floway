import { withRoleCompatibilityApplied } from './apply-role-compatibility.ts';
import { withResponsesOutputItemsCanonicalized } from './canonicalize-output-items.ts';
import { withResponsesCompactShim } from './compact-shim.ts';
import { withReasoningDisabledOnForcedToolChoice } from './disable-reasoning-on-forced-tool-choice.ts';
import { withCyberPolicyRetried } from './retry-cyber-policy.ts';
import { withResponsesServerToolShim } from './server-tool-shim.ts';
import { imageGenerationServerTool } from './server-tools/image-generation.ts';
import { webSearchServerTool } from './server-tools/web-search.ts';
import { withPromptCacheKeyStripped } from './strip-prompt-cache-key.ts';
import type { ResponsesInterceptor } from './types.ts';
import { withVendorDeepseekResponsesNormalize } from './vendor-deepseek-normalize.ts';
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
//   - withCyberPolicyRetried: gated by `retry-cyber-policy`.
//   - withReasoningDisabledOnForcedToolChoice: gated by
//     `disable-reasoning-on-forced-tool-choice`.
//   - withRoleCompatibilityApplied: applies role flags in the fixed order
//     `system → developer → system → user`; later demotions are authoritative
//     when flags overlap, and the final step affects only interleaved system.
//   - withPromptCacheKeyStripped: gated by `strip-prompt-cache-key`. Drops
//     the top-level `prompt_cache_key` field for upstreams that reject it
//     as an unknown argument (e.g. Azure DeepSeek). Runs before vendor
//     normalizers so vendor-specific translation sees the already-stripped
//     canonical payload.
//   - withVendor*ResponsesNormalize: gated by `vendor-<X>`. Registered after
//     the role-compatibility entry so each gets the final say on the outbound wire
//     body.
//   - withResponsesOutputItemsCanonicalized: runs innermost (last entry)
//     so it observes the raw upstream event stream first, before any outer
//     interceptor inspects ids or hashes content. Pins each output item's
//     `id` and `encrypted_content` across the streamed `output_item.done`
//     view and the terminal `response.completed` envelope; downstream
//     consumers (server-tool shim, storage layer's id mapper, replay
//     affinity) then see a single canonical pair per item.
export const responsesInterceptors: readonly ResponsesInterceptor[] = [
  withResponsesCompactShim,
  withResponsesServerToolShim([
    webSearchServerTool,
    imageGenerationServerTool,
  ]),
  withCyberPolicyRetried,
  withReasoningDisabledOnForcedToolChoice,
  withRoleCompatibilityApplied,
  withPromptCacheKeyStripped,
  withVendorDeepseekResponsesNormalize,
  withVendorQwenResponsesNormalize,
  withResponsesOutputItemsCanonicalized,
];
