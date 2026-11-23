import type { IntoMap, Pipeline, TargetMap } from './compose.ts';
import type { Facts } from './facts.ts';
import type { Deferred, DeferredHandle, ManagedStream } from './handles.ts';
import type { RunHandle } from './run.ts';
import type { CreateStreamOptions, WrapStreamOptions, WrapStreamsOptions } from './stream.ts';

export type LogLevel = 'debug' | 'info' | 'warn' | 'error';

export type StageLogger = Readonly<Record<LogLevel, (message: string, fields?: Facts) => void>>;

interface StreamMethods<Self> {
  readonly createStream: <T>(options: CreateStreamOptions<T, Self>) => ManagedStream<T>;
  readonly wrapStream: {
    <In, Out>(inner: ManagedStream<In>, options: WrapStreamOptions<In, Out, Self>): ManagedStream<Out>;
    <Ins extends Record<string, unknown>, Out>(
      inners: { readonly [K in keyof Ins]: ManagedStream<Ins[K]> }, options: WrapStreamsOptions<Ins, Out, Self>,
    ): ManagedStream<Out>;
  };
}

export interface Scope<S = {}> extends StreamMethods<Scope<S>> {
  readonly runId: string;
  readonly stageId: number;
  readonly stageName: string;
  readonly signal: AbortSignal;
  readonly clock: () => number;
  readonly log: StageLogger;
  readonly services: Readonly<S>;
  readonly defer: <T>(name: string, work: Promise<T>) => Deferred<T>;
  readonly deferred: <T>(name: string, owner: ManagedStream<unknown>) => DeferredHandle<T>;
  readonly run: <I, O, S2>(pipeline: Pipeline<I, O, S2> & Pipeline<I, O, S>, facts: I) => RunHandle<O>;
}

export interface StageScope<Down, Up, S = {}> extends Scope<S> {
  readonly next: Next<Down, Up>;
  readonly createStream: StreamMethods<StageScope<Down, Up, S>>['createStream'];
  readonly wrapStream: StreamMethods<StageScope<Down, Up, S>>['wrapStream'];
}

export interface EndingScope<Targets extends TargetMap, S = {}> extends Scope<S> {
  readonly into: IntoMap<Targets>;
  readonly createStream: StreamMethods<EndingScope<Targets, S>>['createStream'];
  readonly wrapStream: StreamMethods<EndingScope<Targets, S>>['wrapStream'];
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

export interface ReturnDecl {
  readonly provides: readonly string[];
}

export interface ChildOptions {
  readonly signal?: AbortSignal;
}

export type Next<Down, Up> = <Actual extends Down>(facts: Actual, options?: ChildOptions) => Promise<Up>;

type Execute<Rq, Down, Up, Rs, S> = (
  facts: Rq, scope: StageScope<Down, Up, S>,
) => Promise<Rs>;

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
  readonly execute: (facts: Rq, scope: Scope<S>) => Promise<Rs>;
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
  readonly execute: (facts: Facts, scope: Scope<S>) => Promise<Facts>;
}

export type Stage<S = {}> = ThroughStage<S> | ReturnStage<S>;

const freezeSide = (side: SideDecl): SideDecl => Object.freeze({
  needs: Object.freeze([...side.needs]),
  consumes: Object.freeze([...side.consumes]),
  provides: Object.freeze([...side.provides]),
});

export function defineStage<Rq, Down, Up, Rs, S = {}>(options: ThroughOptions<Rq, Down, Up, Rs, S>): ThroughStage<S>;
export function defineStage<Rq, Rs, S = {}>(options: ReturnOptions<Rq, Rs, S>): ReturnStage<S>;
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

type TransformSide<In, Out> = (facts: In) => Out | Promise<Out>;

type TransformSides<Rq, Down, Up, Rs> = (
  [Rq] extends [Down] ? { readonly request?: TransformSide<Rq, Down> } : { readonly request: TransformSide<Rq, Down> }
) & (
  [Up] extends [Rs] ? { readonly response?: TransformSide<Up, Rs> } : { readonly response: TransformSide<Up, Rs> }
);

export const transform = <Rq, Down, Up, Rs, S = {}>(
  open: (scope: Scope<S>) => TransformSides<Rq, Down, Up, Rs>,
): Execute<Rq, Down, Up, Rs, S> => async (facts, scope) => {
  const { request, response } = open(scope);
  const back = await scope.next(request ? await request(facts) : facts as Rq & Down);
  return response ? await response(back) : back as Up & Rs;
};

declare const endingTargets: unique symbol;
type IntoDeclarations<T> = { readonly [K in keyof T]: ThroughDecl };

export interface Ending<T extends TargetMap = {}, S = {}> {
  readonly kind: 'ending';
  readonly name: string;
  readonly request: { readonly needs: readonly string[] };
  readonly into?: IntoDeclarations<T>;
  readonly return?: ReturnDecl;
  readonly execute: (facts: Facts, scope: EndingScope<T, S>) => Promise<Facts>;
  readonly [endingTargets]?: (targets: T) => T;
}

type EndingOptions<T extends TargetMap> = keyof T extends never
  ? { readonly into?: undefined; readonly return: ReturnDecl }
  : { readonly into: IntoDeclarations<T>; readonly return?: ReturnDecl };

export const defineEnding = <Rq, Rs, Targets extends TargetMap = {}, S = {}>(options: {
  readonly name: string;
  readonly request: { readonly needs: readonly string[] };
  readonly execute: (facts: Rq, scope: EndingScope<Targets, S>) => Promise<Rs>;
} & EndingOptions<Targets>): Ending<Targets, S> => {
  const { name, request, into, return: answer, execute } = options;
  if (!into && !answer) throw new TypeError(`Ending "${name}" needs an into or return declaration`);
  const declarations = into && Object.freeze(Object.fromEntries(Object.entries<ThroughDecl>(into).map(([key, declaration]) => [key, Object.freeze({
    request: freezeSide(declaration.request), response: freezeSide(declaration.response),
  })]))) as IntoDeclarations<Targets> | undefined;
  return Object.freeze({
    kind: 'ending', name,
    request: Object.freeze({ needs: Object.freeze([...request.needs]) }),
    ...(declarations ? { into: declarations } : {}),
    ...(answer ? { return: Object.freeze({ provides: Object.freeze([...answer.provides]) }) } : {}),
    execute: (facts: Facts, scope: EndingScope<Targets, S>) => execute(facts as Facts & Rq, scope) as Promise<Rs & Facts>,
  });
};
