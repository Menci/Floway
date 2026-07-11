import type { ProtocolFrame } from '@floway-dev/protocols/common';
import type { ExecuteResult } from '@floway-dev/provider';
import type { TranslatedApiError } from '@floway-dev/translate';

// Threads a translate trip around an inner attempt. The trip itself is async
// (the real `@floway-dev/translate` pair functions resolve a `Promise`), so
// `translate` returns the trip object behind a promise. The pair functions
// take `(src, ctx)`; this helper's `translate` parameter stays unary so each
// caller closes over its own `ctx` (`p => translateXViaY(p, ctx)`).
//
// On an upstream api-error the trip's optional `apiError` hook is invoked so
// the pair can rewrite the body into the source protocol's envelope — the
// canonical case is `messages-via-*` translating an upstream context-window
// error into the Anthropic `prompt is too long:` shape Claude Code recognizes
// for auto-compaction. Pairs that don't set `apiError` (or return `undefined`)
// pass the upstream body through verbatim.
export const traverseTranslation = async <SP, TP, SE, TE>(
  payload: SP,
  translate: (p: SP) => Promise<{
    target: TP;
    events: (e: AsyncIterable<ProtocolFrame<TE>>) => AsyncIterable<ProtocolFrame<SE>>;
    apiError?: (upstream: TranslatedApiError) => TranslatedApiError | undefined;
  }>,
  innerAttempt: (translated: TP) => Promise<ExecuteResult<ProtocolFrame<TE>>>,
): Promise<ExecuteResult<ProtocolFrame<SE>>> => {
  const trip = await translate(payload);
  const inner = await innerAttempt(trip.target);
  if (inner.type === 'events') return { ...inner, events: trip.events(inner.events) };
  if (inner.type === 'api-error' && inner.source === 'upstream' && trip.apiError !== undefined) {
    const rewritten = trip.apiError({ status: inner.status, headers: inner.headers, body: inner.body });
    if (rewritten !== undefined) return { ...inner, status: rewritten.status, headers: rewritten.headers, body: rewritten.body };
  }
  return inner;
};
