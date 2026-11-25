import type { Log } from '@guiiai/logg';

import type { Facts } from './facts.ts';
import type { Deferred, ManagedStream, Result } from './values.ts';

export type RunEvent =
  | { readonly type: 'stage.entered'; readonly stageId: number; readonly name: string; readonly parentStageId?: number; readonly facts: Facts }
  | { readonly type: 'stage.leaved'; readonly stageId: number; readonly facts: Facts }
  | { readonly type: 'stage.panicked'; readonly stageId: number; readonly error: unknown; readonly facts?: Facts }
  | { readonly type: 'stream.frame'; readonly stream: ManagedStream<unknown, unknown>; readonly item: Result<unknown, unknown> }
  | { readonly type: 'stream.end'; readonly stream: ManagedStream<unknown, unknown> }
  | { readonly type: 'deferred.settled'; readonly deferred: Deferred<unknown> } & Result<unknown, unknown>
  | { readonly type: 'log'; readonly stageId: number } & Log;
