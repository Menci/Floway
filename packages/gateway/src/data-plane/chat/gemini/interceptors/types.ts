import type { GatewayCtx } from '../../../shared/gateway-ctx.ts';
import type { Interceptor } from '@floway-dev/interceptor';
import type { ProtocolFrame } from '@floway-dev/protocols/common';
import type { GeminiStreamEvent } from '@floway-dev/protocols/gemini';
import type { ExecuteResult, GeminiInvocation, PlainResult } from '@floway-dev/provider';

export type GeminiInterceptor = Interceptor<
  GeminiInvocation,
  GatewayCtx,
  ExecuteResult<ProtocolFrame<GeminiStreamEvent>>
>;

// countTokens is a one-shot, non-streaming HTTP exchange — the terminal
// returns a `PlainResult` carrying the reshaped Gemini envelope, not an event
// stream. The interceptor chain still runs against a `GeminiInvocation` so
// payload-shaped reads stay symmetric with the generate path. Interceptors
// registered here MUST be pure header/payload mutators; post-`run()` result
// inspection is not portable to this result type.
export type GeminiCountTokensInterceptor = Interceptor<
  GeminiInvocation,
  GatewayCtx,
  PlainResult
>;
