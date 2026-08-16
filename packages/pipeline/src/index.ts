// The pipeline core: one immutable record of facts, and a list of stages that each
// declare which facts they touch.
//
// Nothing here knows what a model is. The gateway and the provider packages compose these
// pieces; this package is what they compose.

export { assertHandedOver, move } from './facts.ts';
export type { Facts, Handed, Slice } from './facts.ts';

export { defineStage, transform } from './stage.ts';
export type {
  Descend,
  ErasedPass,
  ErasedSide,
  IntoNext,
  Logger,
  LogLevel,
  Open,
  PassDecl,
  Pipeline,
  ReturnDecl,
  RunScope,
  RunServices,
  Stage,
  ThroughNext,
  Use,
} from './stage.ts';

export { compose } from './compose.ts';

export { defer, isDeferred, isOwned, own, run } from './run.ts';
export type { Deferred, Owned, RunResult } from './run.ts';

export {
  createEncoder,
  createRunEncoder,
  decodeKey,
  encodeKey,
  encodeRun,
  isSecret,
  isStreamFact,
  secret,
  storedSecret,
  streamFact,
  toNdjson,
} from './dump.ts';
export type { DumpEvent, Event, Ref, Secret, Stored, StoredSecret, StreamFact } from './dump.ts';
