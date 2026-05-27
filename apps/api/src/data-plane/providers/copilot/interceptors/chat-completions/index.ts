// Copilot-only Chat Completions target workarounds. The Copilot provider
// attaches this set to its provider metadata, so target interceptor assembly
// does not need to know which provider kind is running.

// Copilot-only Chat Completions target workarounds. The Copilot provider
// attaches this set to its provider metadata, so target interceptor assembly
// does not need to know which provider kind is running.

import { withToolArgumentWhitespaceAborted } from './abort-on-tool-argument-whitespace.ts';
import { withCacheControlMarkersAttached } from './attach-cache-control-markers.ts';
import { withInitiatorHeaderSet } from './set-initiator-header.ts';
import { withVisionHeaderSet } from './set-vision-header.ts';
import type { ChatCompletionsInterceptor } from '../../../../llm/interceptors.ts';

// Order matters: payload-mutating interceptors run first so the header
// interceptors see the final outgoing payload, then header interceptors
// populate `invocation.headers` for the upstream call. Cache-control marker
// attachment is a payload mutator, so it sits with the other payload
// mutators and before any header derivation.
export const chatCompletionsCopilotInterceptors = [
  withToolArgumentWhitespaceAborted,
  withCacheControlMarkersAttached,
  withInitiatorHeaderSet,
  withVisionHeaderSet,
] as const satisfies readonly ChatCompletionsInterceptor[];
