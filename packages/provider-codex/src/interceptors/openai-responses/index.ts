// Codex-only OpenAI Responses workarounds. The chain is a boundary the Codex provider
// runs inside its own call methods, so the gateway main flow never knows that
// Codex has OpenAI Responses interceptors at all.

import { injectDefaultInstructions } from './inject-default-instructions.ts';
import { stripUnsupportedFields } from './strip-unsupported-fields.ts';
import type { OpenAIResponsesBoundaryCtx } from './types.ts';
import type { Interceptor } from '@floway-dev/interceptor';
import type { ProviderOpenAIResponsesResult } from '@floway-dev/provider';

// Order rationale: neither interceptor below reads or writes a field the
// other touches, so order is positional only.
//
// Codex interceptors are pure payload/header mutators, so the chain's only
// terminal — the streaming `generate` + non-streaming `compact` dispatch —
// returns its `ProviderOpenAIResponsesResult` directly without any per-frame
// lift/lower step.
export const CODEX_OPENAI_RESPONSES_BOUNDARY: readonly Interceptor<OpenAIResponsesBoundaryCtx, object, ProviderOpenAIResponsesResult>[] = [
  injectDefaultInstructions,
  stripUnsupportedFields,
];
