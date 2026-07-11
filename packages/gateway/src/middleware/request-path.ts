// The single classifier + redactor for the public Agent Setup script routes.
// The classifier is shared by auth (skip authentication), the CORS layer (skip
// CORS), and the internal-error response (return a fully opaque 500 that
// reveals neither the token nor any secret the thrown error carried). The
// redactor is shared by the request logger (scrub the token before it reaches a
// log line) and the internal-error response's non-setup branch (scrub a
// near-miss, still script-shaped path before it reaches the 500 body). Keeping
// one source of truth means the "what counts as a public script URL" and "how
// is the token scrubbed" decisions can never drift between the layers that must
// agree on them.

// A setup token is 32 CSPRNG bytes as an unpadded base64url string — exactly 43
// characters of the base64url alphabet. The public matcher is deliberately
// exact: only GET/HEAD, only a token of this precise shape, only the two script
// filenames. Anything else stays on the authenticated path.
const PUBLIC_SETUP_SCRIPT_RE = /^\/api\/setup\/[A-Za-z0-9_-]{43}\/setup\.(?:sh|ps1)$/;

// The redactor is looser than the matcher on purpose: it scrubs the token
// segment of any `/api/setup/<segment>/setup.(sh|ps1)` shaped path, so a
// near-miss token (wrong length, stray characters) that still routes through a
// log or error body is scrubbed too, never echoed verbatim.
const SETUP_SCRIPT_PATH_RE = /^(\/api\/setup\/)[^/]+(\/setup\.(?:sh|ps1))$/;

export const isPublicSetupScriptRequest = (method: string, path: string): boolean =>
  (method === 'GET' || method === 'HEAD') && PUBLIC_SETUP_SCRIPT_RE.test(path);

export const redactSetupTokenPath = (path: string): string =>
  path.replace(SETUP_SCRIPT_PATH_RE, '$1[redacted]$2');
