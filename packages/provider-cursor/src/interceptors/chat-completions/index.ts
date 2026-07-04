// Cursor Chat Completions interceptors. The chain runs inside the provider's
// callChatCompletions, so the gateway main flow is unaware of it.

import { injectDefaultInstructions } from './inject-default-instructions.ts';
import { stripUnsupportedFields } from './strip-unsupported-fields.ts';
import type { ChatCompletionsBoundaryCtx } from './types.ts';
import type { Interceptor } from '@floway-dev/interceptor';

// Neither interceptor reads a field the other writes, so the listing order is
// positional.
export const cursorChatCompletionsChain = <TResult>(): readonly Interceptor<ChatCompletionsBoundaryCtx, object, TResult>[] => [
  injectDefaultInstructions,
  stripUnsupportedFields,
];
