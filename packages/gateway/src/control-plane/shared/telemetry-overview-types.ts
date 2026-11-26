export interface TelemetryKeyMetadata {
  id: string;
  name: string;
  createdAt: string;
}

export interface TelemetryUserMetadata {
  id: number;
  username: string;
}

export interface TelemetryOverviewScope {
  actorId: number;
  ownedKeyIds: string[];
  visibility: 'owned-keys' | 'all' | { userIds: number[]; upstreamIds: string[] };
}

export interface TelemetryOverviewSnapshot<Bucket> {
  cursor: string;
  reset: boolean;
  start: string;
  end: string;
  buckets: Bucket[];
  scope: TelemetryOverviewScope;
  metadataVisibility: { complete: boolean; userIds: number[]; upstreamIds: string[] };
  users: TelemetryUserMetadata[];
  upstreams: Array<{ id: string; name: string; hue: number }>;
  keys: TelemetryKeyMetadata[];
}
