// Public naming policy. The catalog's opaque `kimi-for-coding*` ids describe a
// channel rather than a model, so their published ids are derived from the
// catalog display name; every other id is published under a `kimi-` prefix.
// Only the derivation is presentation: the catalog id stays authoritative on
// the wire, and a future explicit public-id catalog field would supersede it.
// https://www.kimi.com/code/docs/en/kimi-code/models.html
//
// A mistyped id is not rejected by the service: it routes to the default K2
// model while echoing the id it was given, so a derived id must never be sent
// upstream. The same page documents the fallback.
// https://www.kimi.com/code/docs/en/kimi-code/models.html
const OPAQUE_CODING_ID = /^kimi-for-coding(?:-|$)/;

export const publicKimiCodeModelId = (upstreamModelId: string, displayName: string): string | null => {
  if (!OPAQUE_CODING_ID.test(upstreamModelId)) return `kimi-${upstreamModelId}`;
  const match = /^\s*(k\d+\.\d+)(?:\s+(preview|code))?(?:\s+highspeed)?\s*$/i.exec(displayName);
  return match === null
    ? null
    : `kimi-${match[1].toLowerCase()}${match[2] === undefined ? '' : `-${match[2].toLowerCase()}`}${upstreamModelId.endsWith('-highspeed') ? '-highspeed' : ''}`;
};
