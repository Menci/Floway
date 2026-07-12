import type { Context } from 'hono';

// Headers stripped from the inbound request before the data plane threads
// the bag down to the provider boundary. Four groups, one deny-list:
//
// - Gateway-owned auth + identity. Providers pin their own credentials and
//   content-type on the wire (Azure's `api-key`, Anthropic's `x-api-key`,
//   `Authorization: Bearer`, each provider's body-derived `content-type`,
//   the runtime's freshly-derived multipart boundary for FormData
//   passthrough). Letting any of these survive would clobber a pinned
//   value or leak a private one.
//
// - HTTP/1.1 framing + hop-by-hop (RFC 9110 §7.6.1). `content-length`,
//   `content-encoding`, and `transfer-encoding` describe the inbound body
//   and would mis-frame the re-serialized outbound body — on Node this
//   surfaces as undici's `RequestContentLengthMismatchError`; Workers'
//   `fetch` silently rewrites the framing. `connection`, `keep-alive`,
//   `proxy-connection`, `te`, `trailer`, `upgrade`, `expect` are end-to-end
//   meaningless; the runtime fetch refuses most of them outright.
//
// - `accept-encoding`. End-to-end in spec terms, transport-level in
//   practice: the runtime fetch advertises the encodings it can
//   transparently decode, and SSE upstreams must stay uncompressed
//   end-to-end so stream parsers see raw bytes.
//
// - Client-IP / geo propagation signals injected by the runtime edge or by
//   any reverse proxy in front of us: every `cf-*` header Cloudflare adds
//   (`cf-connecting-ip`, `cf-ipcountry`, `cf-ray`, `cf-visitor`,
//   `cf-warp-tag-id`, `cf-worker`, and a long tail of geo/ASN entries that
//   Cloudflare extends over time — matched by prefix rather than
//   enumeration), the RFC 7239 `forwarded` chain, the de-facto
//   `x-forwarded-*` family, `x-real-ip`, `x-client-ip`, `true-client-ip`,
//   and the RFC 8586 `cdn-loop` cookie. Forwarding these is both a privacy
//   leak (the client's real IP and coarse geo reach the LLM upstream) and
//   an availability hazard: OpenAI's Cloudflare WAF 403s Codex Responses
//   requests when downstream `cf-*` signals disagree with our egress IP,
//   the same shape cubercsl reported for a Node deployment behind a
//   Cloudflare reverse proxy.
//
// Vendor business headers (`user-agent`, `anthropic-*` / `openai-*` betas,
// `x-client-request-id`, and any other header the client legitimately
// authored) still reach upstream. Providers that clone the bag before
// merging their own pinned headers inherit the scrub for free.
const SCRUBBED_INBOUND_HEADER_NAMES = [
  'accept-encoding',
  'api-key',
  'authorization',
  'cdn-loop',
  'connection',
  'content-encoding',
  'content-length',
  'content-type',
  'cookie',
  'expect',
  'forwarded',
  'host',
  'keep-alive',
  'proxy-authorization',
  'proxy-connection',
  'te',
  'trailer',
  'transfer-encoding',
  'true-client-ip',
  'upgrade',
  'x-api-key',
  'x-client-ip',
  'x-floway-session',
  'x-forwarded-for',
  'x-forwarded-host',
  'x-forwarded-proto',
  'x-goog-api-key',
  'x-real-ip',
];

const SCRUBBED_INBOUND_HEADER_PREFIXES = ['cf-'];

// Build the unified inbound-headers bag the data plane threads to the
// provider boundary. Copies the source request's headers and removes the
// scrub set before the provider can observe them, regardless of whether
// the provider passes the bag through (Azure, custom, Ollama) or clones
// it into a boundary ctx (Copilot, Codex).
export const inboundHeadersForUpstream = (c: Context): Headers => {
  const headers = new Headers(c.req.raw.headers);
  for (const name of SCRUBBED_INBOUND_HEADER_NAMES) headers.delete(name);
  for (const name of [...headers.keys()]) {
    if (SCRUBBED_INBOUND_HEADER_PREFIXES.some(prefix => name.startsWith(prefix))) headers.delete(name);
  }
  return headers;
};
