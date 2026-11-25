import type { Log } from '@guiiai/logg';

import type { Facts, Result } from './values.ts';

export type RunEvent =
  | { readonly type: 'stage.entered'; readonly stageId: number; readonly name: string; readonly parentStageId?: number; readonly facts: Facts }
  | { readonly type: 'stage.leaved'; readonly stageId: number; readonly facts: Facts }
  | { readonly type: 'stage.leaved'; readonly stageId: number; readonly error: unknown }
  | { readonly type: 'stream.frame'; readonly streamId: number; readonly item: Result<unknown, unknown> }
  | { readonly type: 'stream.end'; readonly streamId: number }
  | { readonly type: 'stream.end'; readonly streamId: number; readonly error: unknown }
  | { readonly type: 'deferred.settled'; readonly deferredId: number; readonly value: unknown }
  | { readonly type: 'deferred.settled'; readonly deferredId: number; readonly error: unknown }
  | ({ readonly type: 'log'; readonly stageId: number } & Log);

export type Emit = (event: RunEvent) => void;

export type IdOf = (value: unknown) => { streamId: number } | { deferredId: number } | undefined;
export type Observer = (event: RunEvent, idOf: IdOf) => void;
