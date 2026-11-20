// Public naming policy. The catalog's opaque `kimi-for-coding*` ids describe a
// channel rather than a model, so their published ids are derived from the
// catalog display name; every other family gets a `kimi-` prefix. Highspeed
// names a request-time lane, so it does not survive in a public family id.
// The catalog id stays authoritative on the wire. The documentation describes
// a mistyped-id fallback to K2.8 Preview without thinking. In observed chat
// generation, a nonexistent kimi- id echoed that id with a successful response,
// while a nonexistent k3- id was rejected; count_tokens accepted both.
// https://www.kimi.com/code/docs/en/kimi-code/models.html
const OPAQUE_CODING_ID = /^kimi-for-coding(?:-|$)/;

export const parseKimiCodeModelName = (displayName: string): { version: string; family?: string } | null => {
  // Family words define identity; prose after Highspeed is advertising copy,
  // as in the catalog's "K3.1 Pro Highspeed 2x Usage Cost" display name.
  // https://www.kimi.com/code/docs/en/kimi-code/models.html
  const match = /^(k\d+(?:\.\d+)?)(?:\s+(preview|code|pro))?(?:\s+(highspeed)(?:\s+.*)?)?$/i.exec(displayName.trim());
  if (match === null) return null;
  const family = match[2]?.toLowerCase();
  if (family === 'preview' && match[3] !== undefined) return null;
  return { version: match[1].toLowerCase(), ...(family === undefined ? {} : { family }) };
};

export const publicKimiCodeModelId = (upstreamModelId: string, displayName: string): string | null => {
  if (!OPAQUE_CODING_ID.test(upstreamModelId)) return `kimi-${upstreamModelId.replace(/-highspeed$/, '')}`;
  const name = parseKimiCodeModelName(displayName);
  return name === null
    ? null
    : `kimi-${name.version}${name.family === undefined ? '' : `-${name.family}`}`;
};

// Presentation accepts branded, hyphenated and unknown names independently of
// the strict catalog identity grammar used to pair request-time lanes.
export const kimiCodeModelLabel = (displayName: string): string => {
  const name = displayName.trim()
    .replace(/^kimi(?:\s+|$)/i, '')
    .replace(/(?:^|[\s(-]+)highspeed\b[\s\S]*$/i, '')
    .trim();
  if (name === '') throw new TypeError('Kimi Code model display name must contain a model name');
  const match = /^(k\d+(?:\.\d+)?)(?:[\s-]+(preview|code|pro))?$/i.exec(name);
  if (match === null) return `Kimi ${name.replace(/^k(?=\d)/i, 'K')}`;
  const family = match[2]?.toLowerCase();
  return `Kimi ${match[1].replace(/^k/i, 'K')}${family === undefined ? '' : ` ${family[0].toUpperCase()}${family.slice(1)}`}`;
};
