// Copilot-only Messages workarounds. Each list is a boundary chain the
// Copilot provider runs inside its own `callX` methods, so the gateway main
// flow never knows that Copilot has interceptors at all.

import { withTopLevelCacheControlApplied } from './apply-top-level-cache-control.ts';
import { withInlineImagesCompressed } from './compress-images.ts';
import { withSpeedFast } from './handle-speed-fast.ts';
import { withAnthropicBetaNormalized } from './normalize-anthropic-beta.ts';
import { withThinkingDisplayPromoted } from './promote-thinking-display.ts';
import { rewriteContextWindowError } from './rewrite-context-window-error.ts';
import { withClaudeAgentHeadersSet } from './set-claude-agent-headers.ts';
import { withCompactHeadersSet } from './set-compact-headers.ts';
import { withInitiatorHeaderSet } from './set-initiator-header.ts';
import { withInteractionIdHeaderSet } from './set-interaction-id-header.ts';
import { withVisionHeaderSet } from './set-vision-header.ts';
import { withCacheControlExtensionsStripped } from './strip-cache-control-extensions.ts';
import { withEagerInputStreamingStripped } from './strip-eager-input-streaming.ts';
import type { CopilotMessagesBoundaryInterceptor, CopilotMessagesCountTokensBoundaryInterceptor } from './types.ts';

// Order rationale, split into two lanes that run back-to-back:
//
// Lane 1 — source-shape header derivation (must read the pre-mutation
// payload):
//   - rewriteContextWindowError wraps the whole chain so any upstream context-
//     window failure surfaced from the terminal is rewritten into a
//     Messages-shaped invalid_request_error before later interceptors see it.
//   - withCompactHeadersSet pins the compact/auto-continue intent first.
//   - withClaudeAgentHeadersSet then overrides those intents (and the
//     user-agent / copilot-integration-id) for Claude Code SDK proxy traffic.
//   - withInteractionIdHeaderSet finally sets `x-interaction-id` from the
//     same parsed metadata.
//
// Lane 2 — wire-shape mutators followed by header-from-wire derivation:
//   Payload mutators run first so the header interceptors see the final
//   outgoing payload; withTopLevelCacheControlApplied runs before
//   withCacheControlExtensionsStripped so the ported marker on the last
//   cacheable block is cleaned in the same pass. withSpeedFast strips the
//   client's `speed` field (already consumed by callMessages for raw-variant
//   selection) and post-`run()` stamps `usage.speed='fast'` onto outbound
//   message_start/message_delta events when Fast Mode was requested. The
//   header lane closes by normalizing admitted caller beta intent, then adding
//   tokens required by the final thinking and context-management shape.
//   `withInitiatorHeaderSet` re-derives x-initiator from the final last-message
//   structure and may overwrite the
//   compact-tagged value above — that mirrors the pre-boundary target-side
//   override.
//
// `withMessagesWebSearchShim` is intentionally NOT registered here. It runs
// in the gateway's `messagesInterceptors` (filtered by enabled flags); the
// Copilot provider opts in by listing `messages-web-search-shim` in its
// default flag set (see COPILOT_DEFAULT_FLAGS in ../../defaults.ts).
export const COPILOT_MESSAGES_BOUNDARY = [
  rewriteContextWindowError,
  withCompactHeadersSet,
  withClaudeAgentHeadersSet,
  withInteractionIdHeaderSet,
  withInlineImagesCompressed,
  withSpeedFast,
  withThinkingDisplayPromoted,
  withTopLevelCacheControlApplied,
  withCacheControlExtensionsStripped,
  withEagerInputStreamingStripped,
  withVisionHeaderSet,
  withInitiatorHeaderSet,
  withAnthropicBetaNormalized,
] as const satisfies readonly CopilotMessagesBoundaryInterceptor[];

// /v1/messages/count_tokens is a one-shot HTTP exchange that returns the raw
// upstream Response. The Copilot provider applies vision detection,
// x-initiator classification and normalized caller/payload beta intent to both
// chat and count_tokens.
//
// withInlineImagesCompressed runs first so count_tokens sizes the same
// WebP-recompressed payload the chat path sends, keeping the estimate
// consistent with the real request. The chat boundary's other
// entries stay out: its post-`run()` inspectors cannot be expressed against a
// raw Response at all, and the remaining payload mutators and header setters
// each answer something we observed on the generation endpoint, with no
// equivalent need seen on count_tokens.
export const COPILOT_MESSAGES_COUNT_TOKENS_BOUNDARY = [
  withInlineImagesCompressed,
  withVisionHeaderSet,
  withInitiatorHeaderSet,
  withAnthropicBetaNormalized,
] as const satisfies readonly CopilotMessagesCountTokensBoundaryInterceptor[];
