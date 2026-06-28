// Append a parenthetical clause to a "model not found / unsupported"
// error body when one or more upstreams' catalog fetches rejected
// during the request. Surfaced inline alongside the per-request 4xx
// so a client can tell a genuine miss from a transient outage where
// the upstream that owns the model is currently unreachable. The same
// data is independently visible to operators on the dashboard via
// `modelsCache.lastError`.
//
// The suffix is inserted *before* a trailing `.` so the final message
// reads "Model X is not available on any configured upstream (models
// from upstream(s) "a" failed to load).", not "endpoint. (...load).".
//
// Returns the message unchanged when no upstream failed.
export const appendFailedUpstreams = (message: string, failedUpstreams: readonly string[]): string => {
  if (failedUpstreams.length === 0) return message;
  const names = failedUpstreams.map(name => `"${name}"`).join(', ');
  const suffix = ` (models from upstream(s) ${names} failed to load)`;
  return message.endsWith('.') ? `${message.slice(0, -1)}${suffix}.` : `${message}${suffix}`;
};
