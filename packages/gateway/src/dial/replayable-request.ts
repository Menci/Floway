import type { HttpRequest, HttpRequestBody } from '@floway-dev/http';
import { normalizeDialHost } from '@floway-dev/platform';
import type { ProxyRequestTarget } from '@floway-dev/proxy';
import { createReplayableBody, nativeFetchInit, replayableBodySource, replayableBodyStream, validateReplayableBodySource, type ReplayableBodySource } from '@floway-dev/provider';

interface MaterializedRequest {
  target: ProxyRequestTarget;
  request: HttpRequest;
}

// A runtime fetch rejection does not say whether request bytes reached the
// network, so only a bodyless method on Floway's owned safe-read surface can
// move to another transport without risking a duplicate side effect. TRACE is
// intentionally absent: Floway does not own a TRACE surface, and RFC 9110
// §9.3.8 imposes additional credential stripping.
// https://www.rfc-editor.org/rfc/rfc9110.html#section-9.2.1
// https://www.rfc-editor.org/rfc/rfc9110.html#section-9.3.8
// HEAD is intentionally absent until the raw HTTP response layer can frame a
// no-body HEAD response instead of rejecting HEAD_REQUEST_REJECTED.
const SAFE_BODYLESS_RETRY_METHODS = new Set(['GET', 'OPTIONS']);

export interface ReplayableRequest {
  readonly signal: AbortSignal | undefined;
  readonly canRetryAfterAmbiguousFailure: boolean;
  fetchInit(): RequestInit;
  materialized(): Promise<MaterializedRequest>;
}

class ReplayableRequestOwner implements ReplayableRequest {
  readonly signal: AbortSignal | undefined;
  readonly canRetryAfterAmbiguousFailure: boolean;
  private fetch: RequestInit;
  private materializedRequest: MaterializedRequest | undefined;
  private rebuildFetchBody = false;
  private readonly replayableSource: ReplayableBodySource | null;

  constructor(
    private readonly url: string,
    init: RequestInit,
  ) {
    this.signal = init.signal ?? undefined;
    this.canRetryAfterAmbiguousFailure = init.body == null
      && SAFE_BODYLESS_RETRY_METHODS.has((init.method ?? 'GET').toUpperCase());
    this.replayableSource = replayableBodySource(init.body);
    this.fetch = this.replayableSource === null ? init : { ...init, body: null };
  }

  fetchInit(): RequestInit {
    if (this.replayableSource !== null) {
      return nativeFetchInit({ ...this.fetch, body: replayableBodyStream(this.replayableSource) });
    }
    if (this.rebuildFetchBody) {
      this.fetch = rebuildInitFromMaterialized(this.fetch, this.materializedRequest!);
      this.rebuildFetchBody = false;
    }
    return this.fetch;
  }

  async materialized(): Promise<MaterializedRequest> {
    if (this.materializedRequest !== undefined) return this.materializedRequest;
    this.materializedRequest = await buildMaterializedRequest(this.url, this.fetch, this.replayableSource);
    // Once bytes exist, the original BodyInit must not remain captured for the
    // duration of the upstream request. A later direct-fetch fallback rebuilds its
    // owned byte body lazily, so a successful proxy does not retain a second
    // full buffer merely because `direct_fetch` appears later in the list.
    this.fetch = { ...this.fetch, body: null };
    this.rebuildFetchBody = true;
    return this.materializedRequest;
  }
}

export const createReplayableRequest = (url: string, init: RequestInit): ReplayableRequest =>
  new ReplayableRequestOwner(url, init);

const rebuildInitFromMaterialized = (original: RequestInit, materialized: MaterializedRequest): RequestInit => {
  const headers = new Headers(original.headers);
  const targetCt = materialized.request.headers['content-type'];
  if (targetCt !== undefined && !headers.has('content-type')) {
    headers.set('content-type', targetCt);
  }
  // Copy ordinary bodies into a freshly-allocated ArrayBuffer-backed
  // Uint8Array so the BodyInit slot never aliases materialized transport
  // bytes. Segmented bodies remain borrowed views and get a fresh stream.
  let body: BodyInit | null = null;
  if (materialized.request.body instanceof Uint8Array) {
    const owned = new Uint8Array(materialized.request.body.byteLength);
    owned.set(materialized.request.body);
    body = owned;
  } else if (materialized.request.body !== undefined) {
    body = createReplayableBody(materialized.request.body);
  }
  return nativeFetchInit({
    ...original,
    headers,
    body,
  });
};

const buildMaterializedRequest = async (
  url: string,
  init: RequestInit,
  replayableSource: ReplayableBodySource | null,
): Promise<MaterializedRequest> => {
  const u = new URL(url);
  const collected = replayableSource === null
    ? await collectBody(init.body)
    : { body: validateReplayableBodySource(replayableSource).segments };
  const headers = extractHeaders(init.headers);
  // FormData/URLSearchParams synthesize a Content-Type with the multipart
  // boundary or the urlencoded marker. Adopt it only when the caller did not
  // pre-set Content-Type itself, so explicit overrides keep winning.
  if (collected?.contentType !== undefined && headers['content-type'] === undefined) {
    headers['content-type'] = collected.contentType;
  }
  // `URL#hostname` keeps the `[…]` envelope on IPv6 literals; the
  // `DialTarget.host` contract requires the bare address. Strip the
  // brackets here at the URL→DialTarget seam so every dialer sees a
  // canonical host.
  const target: ProxyRequestTarget = {
    host: normalizeDialHost(u.hostname),
    port: u.port ? Number(u.port) : (u.protocol === 'https:' ? 443 : 80),
    tls: u.protocol === 'https:',
  };
  const request: HttpRequest = {
    method: init.method ?? 'GET',
    path: `${u.pathname}${u.search}`,
    headers,
    body: collected?.body,
  };
  return { target, request };
};

// Lower-case keys here so the request is canonical at the seam; the http
// package also lowercases internally, but normalizing at the boundary
// keeps the contract simple.
const extractHeaders = (input: HeadersInit | undefined): Record<string, string> => {
  if (!input) return {};
  if (input instanceof Headers) {
    const out: Record<string, string> = {};
    input.forEach((value, key) => { out[key.toLowerCase()] = value; });
    return out;
  }
  if (Array.isArray(input)) {
    const out: Record<string, string> = {};
    for (const [key, value] of input) out[key.toLowerCase()] = value;
    return out;
  }
  const out: Record<string, string> = {};
  for (const [key, value] of Object.entries(input)) out[key.toLowerCase()] = value;
  return out;
};

interface CollectedBody {
  body: HttpRequestBody;
  /** Content-Type the runtime synthesizes for FormData/URLSearchParams (with
   *  multipart boundary or urlencoded marker). undefined for shapes that
   *  carry no implicit Content-Type. */
  contentType?: string;
}

const collectBody = async (
  body: BodyInit | null | undefined,
): Promise<CollectedBody | undefined> => {
  if (body == null) return undefined;
  if (typeof body === 'string') return { body: new TextEncoder().encode(body) };
  if (body instanceof Uint8Array) return { body };
  if (body instanceof ArrayBuffer) return { body: new Uint8Array(body) };
  if (body instanceof Blob) return { body: new Uint8Array(await body.arrayBuffer()) };
  // FormData / URLSearchParams: round-trip through Request so the runtime
  // produces a canonical multipart/url-encoded byte stream we can buffer
  // alongside the synthesized Content-Type (with boundary or charset).
  if (body instanceof FormData || body instanceof URLSearchParams) {
    const req = new Request('https://internal/', { method: 'POST', body });
    const buffer = new Uint8Array(await req.arrayBuffer());
    const contentType = req.headers.get('content-type') ?? undefined;
    return { body: buffer, contentType };
  }
  throw new Error('unsupported BodyInit shape for materialized request');
};
