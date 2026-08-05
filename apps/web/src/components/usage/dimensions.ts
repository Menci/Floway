const upstreamPrefix = 'upstream:';
const noUpstream = 'none';

export const usageUpstreamValue = (upstream: string | null): string =>
  upstream === null ? noUpstream : `${upstreamPrefix}${upstream}`;

export const upstreamFromUsageValue = (value: string): string | null => {
  if (value === noUpstream) return null;
  if (!value.startsWith(upstreamPrefix)) throw new TypeError(`Invalid Usage upstream dimension value: ${value}`);
  return value.slice(upstreamPrefix.length);
};
