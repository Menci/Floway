import type { AliasRules } from '@floway-dev/protocols/common';

export type AffinityOrigin = 'raw' | 'base64' | 'base64url';

interface AffinityRouteBase {
  upstreamId: string;
  modelId: string;
}

export type AffinityRouteIdentity = AffinityRouteBase & (
  | { rulesPresent: false; rules?: never }
  | { rulesPresent: true; rules: AliasRules }
);

export interface AffinityRestoreMetadata {
  upstreamItemId?: string;
  syntheticItem?: true;
}

export type AffinityTarget = AffinityRouteIdentity & AffinityRestoreMetadata;

export interface AffinityEvidence {
  readonly target: AffinityTarget;
  readonly mode: 'prefer' | 'force';
}

export interface AffinityEnvelope {
  version: 1;
  origin?: AffinityOrigin;
  affinity: AffinityTarget;
}

export type DecodedAffinityBlob =
  | { kind: 'foreign'; value: string }
  | { kind: 'owned'; value?: string; envelope: AffinityEnvelope };
