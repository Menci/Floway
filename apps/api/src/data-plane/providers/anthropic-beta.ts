// Azure (Foundry Anthropic) and custom (api.anthropic.com-shaped) upstreams
// speak Anthropic's native Messages API and accept the full `anthropic-beta`
// header verbatim. Unlike Copilot — whose strict allow-list is enforced by the
// `withAnthropicBetaHeaderFiltered` target interceptor that writes the filtered
// value into the invocation header bag — these providers register no such
// interceptor, so the source-derived beta slice would never reach the wire on
// its own. Merge it into the outgoing headers at call time. A name like
// `with*` is avoided deliberately: that prefix denotes interceptors here, and
// this is a plain synchronous header builder, not a pipeline stage.
export const mergeAnthropicBetaHeader = (
  headers: Record<string, string> | undefined,
  anthropicBeta: readonly string[] | undefined,
): Record<string, string> | undefined => {
  if (!anthropicBeta || anthropicBeta.length === 0) return headers;
  // Spread `headers` last so a caller-set value would win, though for these
  // providers nothing populates `anthropic-beta` in the bag today.
  return { 'anthropic-beta': anthropicBeta.join(','), ...headers };
};
