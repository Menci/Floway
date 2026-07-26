import type { HttpRequest } from '@floway-dev/http';
import { normalizeDialHost } from '@floway-dev/platform';
import type { ProxyRequestTarget } from '@floway-dev/proxy';

interface MaterializedRequest {
  target: ProxyRequestTarget;
  request: HttpRequest;
}

export interface ReplayableRequest {
  readonly signal: AbortSignal | undefined;
  fetchInit(): RequestInit;
  materialized(): Promise<MaterializedRequest>;
}

class ReplayableRequestOwner implements ReplayableRequest {
  readonly signal: AbortSignal | undefined;
  private fetch: RequestInit;
  private materializedRequest: MaterializedRequest | undefined;
  private rebuildFetchBody = false;

  constructor(
    private readonly url: string,
    init: RequestInit,
  ) {
    this.signal = init.signal ?? undefined;
    this.fetch = init;
  }

  fetchInit(): RequestInit {
    if (this.rebuildFetchBody) {
      this.fetch = rebuildInitFromMaterialized(this.fetch, this.materializedRequest!);
      this.rebuildFetchBody = false;
    }
    return this.fetch;
  }

  async materialized(): Promise<MaterializedRequest> {
    if (this.materializedRequest !== undefined) return this.materializedRequest;
    this.materializedRequest = await buildMaterializedRequest(this.url, this.fetch);
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
  // Copy into a freshly-allocated ArrayBuffer-backed Uint8Array so the
  // BodyInit slot accepts it under TypeScript's stricter typing — and so
  // the buffer we hand to runtime fetch never aliases a backing buffer
  // that's also referenced elsewhere.
  let body: Uint8Array<ArrayBuffer> | null = null;
  if (materialized.request.body) {
    const owned = new Uint8Array(materialized.request.body.byteLength);
    owned.set(materialized.request.body);
    body = owned;
  }
  return {
    ...original,
    headers,
    body,
  };
};

const buildMaterializedRequest = async (url: string, init: RequestInit): Promise<MaterializedRequest> => {
  const u = new URL(url);
  const collected = await collectBody(init.body);
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
  body: Uint8Array;
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
