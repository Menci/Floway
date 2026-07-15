import type { AliasRules } from '@floway-dev/protocols/common';

export type AffinityOrigin = 'raw' | 'base64' | 'base64url';

export interface AffinityTarget {
  upstreamId: string;
  modelId: string;
  rulesPresent: boolean;
  rules?: AliasRules;
  upstreamItemId?: string;
  syntheticItem?: true;
  geminiPartFromEnd?: number;
}

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
