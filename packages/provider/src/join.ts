// Helpers for composing upstream URLs from a configured base URL plus a
// per-endpoint path. The gateway stores `baseUrl + path` and stitches them
// without inserting any prefix, so admins can point individual endpoints at
// arbitrary subpaths (e.g. an upstream that exposes `/api/v1/messages` while
// keeping `/models` at the root).
//
// `new URL(path, base)` cannot be used here: when `path` starts with `/`,
// WHATWG URL drops `base`'s pathname segment, which is the opposite of what we
// want for hosts that serve the API under a subpath. So we hand-join after
// trimming the base's trailing slash and validating the path.

const MAX_PATH_LENGTH = 256;
const FORBIDDEN_RAW_PATH_CHARACTERS = /[\\\u0000-\u001f\u007f]/;

export interface ValidatePathOk {
  ok: true;
  value: string;
}
export interface ValidatePathErr {
  ok: false;
  error: string;
}

export const validateUpstreamPath = (raw: unknown, field: string): ValidatePathOk | ValidatePathErr => {
  if (typeof raw !== 'string') {
    return { ok: false, error: `${field} must be a string` };
  }
  const value = raw.trim();
  if (value.length === 0) {
    return { ok: false, error: `${field} is required` };
  }
  if (!value.startsWith('/')) {
    return { ok: false, error: `${field} must start with "/"` };
  }
  if (value.length > MAX_PATH_LENGTH) {
    return { ok: false, error: `${field} is too long` };
  }
  if (value.includes('#')) {
    return { ok: false, error: `${field} must not contain a fragment` };
  }
  if (FORBIDDEN_RAW_PATH_CHARACTERS.test(value)) {
    return { ok: false, error: `${field} contains a forbidden character` };
  }
  if (value.includes('//')) {
    return { ok: false, error: `${field} must not contain "//"` };
  }
  const queryIndex = value.indexOf('?');
  const pathname = queryIndex === -1 ? value : value.slice(0, queryIndex);
  for (const segment of pathname.split('/')) {
    const dots = segment.replace(/%2e/gi, '.');
    if (dots === '.' || dots === '..') {
      return { ok: false, error: `${field} must not contain relative path segments` };
    }
  }
  return { ok: true, value };
};

export const joinBaseAndPath = (baseUrl: string, path: string): string => baseUrl.replace(/\/+$/, '') + path;
