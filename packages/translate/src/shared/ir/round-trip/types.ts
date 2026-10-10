import type { IRProtocol } from '../ir.ts';
import type { IRReplayCandidate, ThinAssistantTurnFor, ThinReference } from '../thin-types.ts';

export interface IRRoundTripReplayCheck {
  version: number;
  digest: Uint8Array;
}

export type IRRoundTripSidecar<Source extends IRProtocol = IRProtocol, Target extends IRProtocol = IRProtocol> = {
  source: Source;
  target: Target;
  thinAssistantTurn: ThinAssistantTurnFor<Target, ThinReference>;
  referencedContents: Uint8Array[];
  replayCheck: IRRoundTripReplayCheck;
};

export type IRRoundTripSidecarEnvelope = {
  [Source in IRProtocol]: {
    [Target in IRProtocol]: IRRoundTripSidecar<Source, Target>
  }[IRProtocol]
}[IRProtocol];

export interface IRRoundTripAssistantTurnInspection {
  sidecars: string[];
  candidates: IRReplayCandidate[];
  checkMaterial: unknown;
}

export type IRRoundTripConversationTurn<Role extends string, Item> = {
  role: Role;
  items: Item[];
};
