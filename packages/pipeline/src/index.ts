import { composeFor } from './compose.ts';
import type { Compose } from './compose.ts';
import type { FactSpaceRef } from './space.ts';
import { defineStageFor } from './stage.ts';
import type { DefineStage } from './stage.ts';

export { asEntry } from './compose.ts';
export type { Entry, Pipeline } from './compose.ts';
export { optional, required } from './declarations.ts';
export type { FactSlot, OptionalSlot, RequiredSlot } from './declarations.ts';
export { createHostScope } from './run.ts';
export { secret } from './secret.ts';
export type { Secret } from './secret.ts';
export { transform } from './stage.ts';
export type {
  AbortHandle,
  HostScope,
  HostScopeOptions,
  ProducerScope,
  RootHostScope,
  RunCallOptions,
  Stage,
  StageScope,
  WorkerScope,
} from './stage.ts';
export type { Deferred, Facts, Handle, ManagedStream, Read, Result, StreamCursor } from './values.ts';

export interface FactSpace<Rq, Rs, S = object> extends FactSpaceRef<Rq, Rs, S> {
  readonly defineStage: DefineStage<Rq, Rs, S>;
  readonly compose: Compose<Rq, Rs, S>;
  extend<
    ExtraRq extends object = object,
    ExtraRs extends object = object,
    SubS extends S = S,
  >(): FactSpace<Rq & ExtraRq, Rs & ExtraRs, SubS>;
}

export const defineFacts = <
  Rq extends object,
  Rs extends object,
  S extends object = object,
>(): FactSpace<Rq, Rs, S> => Object.freeze({
  defineStage: defineStageFor<Rq, Rs, S>(),
  compose: composeFor<Rq, Rs, S>(),
  extend: <
    ExtraRq extends object = object,
    ExtraRs extends object = object,
    SubS extends S = S,
  >() => defineFacts<Rq & ExtraRq, Rs & ExtraRs, SubS>(),
}) as FactSpace<Rq, Rs, S>;
