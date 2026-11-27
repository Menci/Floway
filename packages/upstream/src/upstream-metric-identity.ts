export type UpstreamMetricLabelValue = string | number | boolean | null;
export type UpstreamMetricLabels = Readonly<Record<string, UpstreamMetricLabelValue>>;

export interface UpstreamMetricIdentity {
  name: string;
  labels: UpstreamMetricLabels;
}

export const normalizeUpstreamMetricIdentity = (name: unknown, labels: unknown): UpstreamMetricIdentity => {
  if (typeof name !== 'string' || name.length === 0) throw new TypeError('Upstream metric name must be a nonempty string');
  if (typeof labels !== 'object' || labels === null || Array.isArray(labels)) throw new TypeError('Upstream metric labels must be an object');
  const entries = Object.entries(labels).sort(([left], [right]) => left < right ? -1 : left > right ? 1 : 0).map(([key, value]) => {
    if (key.length === 0) throw new TypeError('Upstream metric label names must be nonempty strings');
    if (typeof value === 'number' && !Number.isFinite(value)) throw new TypeError('Upstream metric number labels must be finite');
    if (value !== null && typeof value !== 'string' && typeof value !== 'number' && typeof value !== 'boolean') throw new TypeError('Upstream metric labels must be flat JSON values');
    return [key, value] as const;
  });
  return { name, labels: Object.fromEntries(entries) };
};

export const upstreamMetricIdentityKey = ({ name, labels }: UpstreamMetricIdentity): string => {
  const normalized = normalizeUpstreamMetricIdentity(name, labels);
  return JSON.stringify([normalized.name, normalized.labels]);
};
