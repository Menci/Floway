// One source of truth for "what is a public Agent Setup script URL" and "how is
// the lease token scrubbed", shared so the layers that must agree cannot drift.
// The matcher gates the auth bypass, the CORS bypass, and the fully-opaque
// internal-error 500; the redactor scrubs tokens out of the request log and the
// non-setup internal-error body.

// A setup token is 32 CSPRNG bytes as unpadded base64url — exactly 43 chars of
// its alphabet. The matcher is deliberately exact: only GET/HEAD, only that
// token shape, only the two script filenames.
const PUBLIC_SETUP_SCRIPT_RE = /^\/api\/setup\/[A-Za-z0-9_-]{43}\/setup\.(?:sh|ps1)$/;

// Looser than the matcher on purpose: it scrubs the token segment of any
// `/api/setup/<segment>/setup.(sh|ps1)`-shaped path, so a near-miss token that
// still reaches a log or error body is scrubbed too, never echoed verbatim.
const SETUP_SCRIPT_PATH_RE = /^(\/api\/setup\/)[^/]+(\/setup\.(?:sh|ps1))$/;

export const isPublicSetupScriptRequest = (method: string, path: string): boolean =>
  (method === 'GET' || method === 'HEAD') && PUBLIC_SETUP_SCRIPT_RE.test(path);

export const redactSetupTokenPath = (path: string): string =>
  path.replace(SETUP_SCRIPT_PATH_RE, '$1[redacted]$2');
