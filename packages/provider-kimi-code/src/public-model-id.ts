// Our public naming policy derives the opaque coding alias from its display
// name for presentation. The catalog id remains authoritative on the wire;
// a future explicit public-id catalog field would supersede this derivation.
// https://www.kimi.com/code/docs/en/kimi-code/models.html
export const publicKimiCodeModelId = (upstreamModelId: string, displayName: string): string | null => {
  if (upstreamModelId !== 'kimi-for-coding') return `kimi-${upstreamModelId}`;
  const match = /^\s*(k\d+\.\d+)(?:\s+(preview|code))?\s*$/i.exec(displayName);
  return match === null ? null : `kimi-${match[1].toLowerCase()}${match[2] === undefined ? '' : `-${match[2].toLowerCase()}`}`;
};
