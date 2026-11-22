import type { IntoMap, Pipeline, TargetMap } from './compose.ts';
import type { Facts, Handed } from './facts.ts';
import type { Deferred, DeferredHandle, ManagedStream } from './handles.ts';
import type { RunHandle } from './run.ts';
import type { CreateStreamOptions, WrapStreamOptions } from './stream.ts';

export type LogLevel = 'debug' | 'info' | 'warn' | 'error';

export type StageLogger = Readonly<Record<LogLevel, (message: string, fields?: Facts) => void>>;

export interface StageEnv<S = {}> {
  readonly runId: string;
  readonly stageId: number;
  readonly stageName: string;
  readonly signal: AbortSignal;
  readonly clock: () => number;
  readonly log: StageLogger;
  readonly services: Readonly<S>;
  readonly createStream: <T>(options: CreateStreamOptions<T>) => ManagedStream<T>;
  readonly wrapStream: <In, Out>(inner: ManagedStream<In>, options: WrapStreamOptions<In, Out>) => ManagedStream<Out>;
  readonly defer: <T>(name: string, work: Promise<T>) => Deferred<T>;
  readonly deferred: <T>(name: string, owner: ManagedStream<unknown> | 'scope') => DeferredHandle<T>;
  readonly run: <I, O, S2>(pipeline: Pipeline<I, O, S2>, facts: I) => RunHandle<O>;
}

export interface SideDecl {
  readonly needs: readonly string[];
  readonly consumes: readonly string[];
  readonly provides: readonly string[];
}

export interface ThroughDecl {
  readonly request: SideDecl;
  readonly response: SideDecl;
}

interface ReturnDecl {
  readonly provides: readonly string[];
}

export type Next<Down, Up> = (facts: Handed<Down>) => Promise<Handed<Up>>;

type Execute<Rq, Down, Up, Rs, S> = (
  facts: Handed<Rq>, next: Next<Down, Up>, env: StageEnv<S>,
) => Promise<Handed<Rs>>;

interface ThroughOptions<Rq, Down, Up, Rs, S> {
  readonly name: string;
  readonly through: ThroughDecl;
  readonly return?: ReturnDecl;
  readonly execute: Execute<Rq, Down, Up, Rs, S>;
}

interface ReturnOptions<Rq, Rs, S> {
  readonly name: string;
  readonly through?: undefined;
  readonly return: ReturnDecl;
  readonly execute: (facts: Handed<Rq>, env: StageEnv<S>) => Promise<Handed<Rs>>;
}

interface ThroughStage<S> {
  readonly kind: 'stage';
  readonly name: string;
  readonly through: ThroughDecl;
  readonly return?: ReturnDecl;
  readonly execute: Execute<Facts, Facts, Facts, Facts, S>;
}

interface ReturnStage<S> {
  readonly kind: 'stage';
  readonly name: string;
  readonly through?: undefined;
  readonly return: ReturnDecl;
  readonly execute: (facts: Facts, env: StageEnv<S>) => Promise<Facts>;
}

export type Stage<S = {}> = ThroughStage<S> | ReturnStage<S>;

const freezeSide = (side: SideDecl): SideDecl => Object.freeze({
  needs: Object.freeze([...side.needs]),
  consumes: Object.freeze([...side.consumes]),
  provides: Object.freeze([...side.provides]),
});

export function defineStage<Rq, Down, Up, Rs, S = {}>(options: ThroughOptions<Rq, Down, Up, Rs, S>): ThroughStage<S>;
export function defineStage<Rq, Rs, S = {}>(options: ReturnOptions<Rq, Rs, S>): ReturnStage<S>;
export function defineStage<Rq, _Down, _Up, Rs, S = {}>(options: ReturnOptions<Rq, Rs, S>): ReturnStage<S>;
export function defineStage(
  options: ThroughOptions<any, any, any, any, any> | ReturnOptions<any, any, any>,
): Stage<any> {
  const { name, through, return: answer } = options;
  if (through) {
    return Object.freeze({
      kind: 'stage', name,
      through: Object.freeze({ request: freezeSide(through.request), response: freezeSide(through.response) }),
      ...(answer ? { return: Object.freeze({ provides: Object.freeze([...answer.provides]) }) } : {}),
      execute: options.execute,
    });
  }
  if (!answer) throw new TypeError(`Stage "${name}" needs a through or return declaration`);
  return Object.freeze({ kind: 'stage', name, return: Object.freeze({ provides: Object.freeze([...answer.provides]) }), execute: options.execute });
}

type TransformSide<In, Out> = (facts: Handed<In>) => Handed<Out> | Promise<Handed<Out>>;

type TransformSides<Rq, Down, Up, Rs> = (
  [Rq] extends [Down] ? { readonly request?: TransformSide<Rq, Down> } : { readonly request: TransformSide<Rq, Down> }
) & (
  [Up] extends [Rs] ? { readonly response?: TransformSide<Up, Rs> } : { readonly response: TransformSide<Up, Rs> }
);

export const transform = <Rq, Down, Up, Rs, S = {}>(
  open: (env: StageEnv<S>) => TransformSides<Rq, Down, Up, Rs>,
): Execute<Rq, Down, Up, Rs, S> => async (facts, next, env) => {
  const { request, response } = open(env);
  const back = await next(request ? await request(facts) : (facts as Facts) as Handed<Down>);
  return response ? await response(back) : (back as Facts) as Handed<Rs>;
};

declare const endingTargets: unique symbol;

export interface Ending<T extends TargetMap = {}, S = {}> {
  readonly kind: 'ending';
  readonly name: string;
  readonly request: { readonly needs: readonly string[] };
  readonly response: { readonly provides: readonly string[] };
  readonly execute: (facts: Facts, into: IntoMap<T>, env: StageEnv<S>) => Promise<Facts>;
  readonly [endingTargets]?: (targets: T) => T;
}

export const defineEnding = <Rq, Rs, Targets extends TargetMap = {}, S = {}>(options: {
  readonly name: string;
  readonly request: { readonly needs: readonly string[] };
  readonly response: { readonly provides: readonly string[] };
  readonly execute: (facts: Handed<Rq>, into: IntoMap<Targets>, env: StageEnv<S>) => Promise<Handed<Rs>>;
}): Ending<Targets, S> => {
  const { name, request, response, execute } = options;
  return Object.freeze({
    kind: 'ending', name,
    request: Object.freeze({ needs: Object.freeze([...request.needs]) }),
    response: Object.freeze({ provides: Object.freeze([...response.provides]) }),
    execute: (facts: Facts, into: IntoMap<Targets>, env: StageEnv<S>) => execute(facts as Handed<Rq>, into, env),
  });
};
