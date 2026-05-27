import type { ResponsesInterceptor } from '../../../interceptors.ts';

// Source-side Responses interceptors. Every entry is attached to every
// binding; each interceptor's body decides whether to act (flag-gated entries
// early-return on `ctx.enabledFlags.has(flagId)`). There are no
// protocol-shape source workarounds today — provider-specific tool stripping
// runs on the target side instead.
export const responsesSourceInterceptors: readonly ResponsesInterceptor[] = [];
