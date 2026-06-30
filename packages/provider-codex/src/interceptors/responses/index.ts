// Codex-only Responses workarounds. The chain is a boundary the Codex provider
// runs inside its own call methods, so the gateway main flow never knows that
// Codex has Responses interceptors at all.

import { injectDefaultInstructions } from './inject-default-instructions.ts';
import { injectSessionId } from './inject-session-id.ts';
import { sanitizeMessageIds } from './sanitize-message-ids.ts';
import { stripUnsupportedFields } from './strip-unsupported-fields.ts';
import type { ResponsesBoundaryCtx } from './types.ts';
import type { Interceptor } from '@floway-dev/interceptor';
import type { ProviderResponsesResult } from '@floway-dev/provider';

// Order rationale: none of the interceptors below read or write a field the
// others touch, so order is positional only. inject-session-id last is
// conventional but not load-bearing — it hashes only `instructions + first
// user-message text`, neither of which is mutated by the earlier mutators.
//
// Codex interceptors are pure payload/header mutators, so the chain's only
// terminal — the streaming `generate` + non-streaming `compact` dispatch —
// returns its `ProviderResponsesResult` directly without any per-frame
// lift/lower step.
export const CODEX_RESPONSES_BOUNDARY: readonly Interceptor<ResponsesBoundaryCtx, object, ProviderResponsesResult>[] = [
  injectDefaultInstructions,
  stripUnsupportedFields,
  sanitizeMessageIds,
  injectSessionId,
];
