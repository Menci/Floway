// Alpha-search upstream Fetch decodes a response's content coding before exposing its body stream,
// but keeps the upstream Content-Encoding and Content-Length headers. Relaying
// that stream with the stale representation headers makes the next Fetch
// consumer decode plain bytes a second time. Rebuild the response around the
// decoded stream and preserve every header that still describes it.

const BLOCKED_RELAY_HEADERS: ReadonlySet<string> = new Set([
  // Hop-by-hop headers (RFC 9110 §7.6.1).
  // https://www.rfc-editor.org/rfc/rfc9110#section-7.6.1
  'connection',
  'keep-alive',
  'proxy-authenticate',
  'proxy-authorization',
  'te',
  'trailer',
  'transfer-encoding',
  'upgrade',
  // Fetch owns the decoded body's representation framing.
  'content-encoding',
  'content-length',
  // Upstream session cookies must not bind a gateway client.
  'set-cookie',
  'set-cookie2',
]);

export const relayFetchedResponse = (response: Response): Response => {
  const headers = new Headers();
  for (const [name, value] of response.headers) {
    if (!BLOCKED_RELAY_HEADERS.has(name.toLowerCase())) headers.set(name, value);
  }
  return new Response(response.body, {
    status: response.status,
    statusText: response.statusText,
    headers,
  });
};
