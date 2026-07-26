// Copilot-only Messages workarounds. Each list is a boundary chain the
// Copilot provider runs inside its own `callX` methods, so the gateway main
// flow never knows that Copilot has interceptors at all.

import { withContextManagementBetaAligned } from './align-context-management-beta.ts';
import { withTopLevelCacheControlApplied } from './apply-top-level-cache-control.ts';
import { withInlineImagesCompressed } from './compress-images.ts';
import { withAnthropicBetaHeaderFiltered } from './filter-anthropic-beta-header.ts';
import { withSpeedFast } from './handle-speed-fast.ts';
import { withThinkingDisplayPromoted } from './promote-thinking-display.ts';
import { rewriteContextWindowError } from './rewrite-context-window-error.ts';
import { withClaudeAgentHeadersSet } from './set-claude-agent-headers.ts';
import { withCompactHeadersSet } from './set-compact-headers.ts';
import { withInitiatorHeaderSet } from './set-initiator-header.ts';
import { withInteractionIdHeaderSet } from './set-interaction-id-header.ts';
import { withVisionHeaderSet } from './set-vision-header.ts';
import { withCacheControlExtensionsStripped } from './strip-cache-control-extensions.ts';
import { withEagerInputStreamingStripped } from './strip-eager-input-streaming.ts';
import { withStructuredOutputFormatStripped } from './strip-structured-output-format.ts';
import { withToolStrictStripped } from './strip-tool-strict.ts';
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
//   header lane closes with anthropic-beta filtering against the Copilot
//   allow-list, then withContextManagementBetaAligned reads the post-filter
//   header and re-pairs `anthropic-beta: context-management-2025-06-27` with
//   any payload that still carries `context_management` — Copilot's strict
//   validator rejects the body field whenever the header is absent,
//   regardless of backend. `withInitiatorHeaderSet` re-derives x-initiator
//   from the final last-message structure and may overwrite the
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
  withToolStrictStripped,
  withStructuredOutputFormatStripped,
  withVisionHeaderSet,
  withInitiatorHeaderSet,
  withAnthropicBetaHeaderFiltered,
  withContextManagementBetaAligned,
] as const satisfies readonly CopilotMessagesBoundaryInterceptor[];

// /v1/messages/count_tokens is a one-shot HTTP exchange that returns the raw
// upstream Response. The Copilot provider applies vision detection,
// x-initiator classification, anthropic-beta allow-list filtering, and
// context-management beta alignment to both chat and count_tokens.
//
// withInlineImagesCompressed runs first so count_tokens sizes the same
// WebP-recompressed payload the chat path sends, keeping the estimate
// consistent with the real request. withContextManagementBetaAligned follows
// withAnthropicBetaHeaderFiltered so any surviving `context_management` field
// remains paired with its required header token. Event-stream and chat-only
// payload mutators are intentionally absent because count_tokens returns a raw
// Response and never used those transformations.
export const COPILOT_MESSAGES_COUNT_TOKENS_BOUNDARY = [
  withInlineImagesCompressed,
  withVisionHeaderSet,
  withInitiatorHeaderSet,
  withAnthropicBetaHeaderFiltered,
  withContextManagementBetaAligned,
] as const satisfies readonly CopilotMessagesCountTokensBoundaryInterceptor[];
