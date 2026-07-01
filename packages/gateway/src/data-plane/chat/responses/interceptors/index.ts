import { withResponsesOutputItemsCanonicalized } from './canonicalize-output-items.ts';
import { withResponsesCompactShim } from './compact-shim.ts';
import { withDemoteDeveloperToSystem } from './demote-developer-to-system.ts';
import { withInterleavedSystemDemotedToUser } from './demote-interleaved-system-to-user.ts';
import { withReasoningDisabledOnForcedToolChoice } from './disable-reasoning-on-forced-tool-choice.ts';
import { withCyberPolicyRetried } from './retry-cyber-policy.ts';
import { withResponsesServerToolShim } from './server-tool-shim.ts';
import { imageGenerationServerTool } from './server-tools/image-generation.ts';
import { webSearchServerTool } from './server-tools/web-search.ts';
import type { ResponsesInterceptor } from './types.ts';
import { withVendorDeepseekResponsesNormalize } from './vendor-deepseek-normalize.ts';
import { withVendorQwenResponsesNormalize } from './vendor-qwen-normalize.ts';

// Unified Responses interceptor list. All entries are attached to every
// candidate; each interceptor's body decides whether to act (flag-gated entries
// early-return on `providerModelOf(ctx.candidate).enabledFlags.has(flagId)`).
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
//   - withDemoteDeveloperToSystem: gated by `demote-developer-to-system`.
//     Runs before withInterleavedSystemDemotedToUser so when both flags are
//     on, a `developer` role first lands as `system`, then any system that
//     ends up after the leading run is rewritten to `user` — the chain
//     `developer → system → user` covers the strictest upstreams.
//   - withInterleavedSystemDemotedToUser: gated by
//     `demote-interleaved-system-to-user`. Walks the input items and
//     rewrites any `role: 'system'` message item that follows the leading
//     contiguous system run to `role: 'user'` so upstreams that reject
//     mid-stream system messages still accept the body.
//   - withVendor*ResponsesNormalize: gated by `vendor-<X>`. Registered after
//     the demotion entries so each gets the final say on the outbound wire
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
  withDemoteDeveloperToSystem,
  withInterleavedSystemDemotedToUser,
  withVendorDeepseekResponsesNormalize,
  withVendorQwenResponsesNormalize,
  withResponsesOutputItemsCanonicalized,
];
