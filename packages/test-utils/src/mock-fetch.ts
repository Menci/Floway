type FetchInput = Parameters<typeof fetch>[0];
type FetchInit = Parameters<typeof fetch>[1];

// Tests share a single globalThis.fetch slot; the lock serializes overlapping
// withMockedFetch calls in the same process so each handler sees only its own
// requests.
let fetchLock: Promise<void> = Promise.resolve();

export async function withMockedFetch<T>(handler: (request: Request) => Promise<Response> | Response, run: () => Promise<T>): Promise<T> {
  let release: (() => void) | undefined;
  const previousLock = fetchLock;
  fetchLock = new Promise<void>(resolve => {
    release = resolve;
  });
  await previousLock;

  const originalFetch = globalThis.fetch;
  globalThis.fetch = (input: FetchInput, init?: FetchInit) => {
    const request = input instanceof Request && init === undefined ? input : new Request(input, init);
    return Promise.resolve(handler(request));
  };

  try {
    return await run();
  } finally {
    globalThis.fetch = originalFetch;
    release?.();
  }
}

export function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

// Minimal SSE 200 response for stubbing streaming endpoints in tests. The
// default body is the OpenAI-style `[DONE]` sentinel; pass arbitrary SSE
// text when a test cares about the upstream's emitted frames. The provider
// rejects 200 responses that are not text/event-stream as a contract
// violation, so streaming-endpoint stubs must use this helper. `extraHeaders`
// carries the response metadata a provider reads alongside the stream, such as
// Copilot's `x-quota-snapshot-*`.
export function sseResponse(body = 'data: [DONE]\n\n', status = 200, extraHeaders: Record<string, string> = {}): Response {
  return new Response(body, {
    status,
    headers: { 'content-type': 'text/event-stream; charset=utf-8', ...extraHeaders },
  });
}
