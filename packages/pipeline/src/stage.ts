import type { Logger } from '@guiiai/logg';

import type { Pipeline } from './compose.ts';
import { parseKeys, parseThrough } from './declarations.ts';
import type { FactKey, FactShape, Handoff, KeyList, Keys, ParsedThrough, Return, Through } from './declarations.ts';
import type { Deferred, Facts, Handle, ManagedStream, Read, Result } from './values.ts';

type Next<Down, Up> = <Actual extends Down>(facts: Actual) => Promise<Up>;

interface WorkerScope<S> {
  readonly log: Logger;
  readonly services: Readonly<S>;
}

interface CommonScope<S> extends WorkerScope<S> {
  readonly signal: AbortSignal;
  readonly abort: (promise: Promise<unknown>) => void;
  readonly run: <I, O>(pipeline: Pipeline<I, O, S>, facts: NoInfer<I>) => Promise<O>;
  readonly read: Read;
  readonly discard: (handle: Handle) => void;
  readonly detach: (worker: (scope: WorkerScope<S>) => Promise<unknown>) => void;
}

interface ProducerMethods<Self> {
  readonly createStream: <T, E>(factory: (scope: Self) => AsyncGenerator<Result<T, E>, void, unknown>) => ManagedStream<T, E>;
  readonly wrapStream: <T, E, U, F>(
    inner: ManagedStream<T, E>,
    factory: (inner: ManagedStream<T, E>, scope: Self) => AsyncGenerator<Result<U, F>, void, unknown>,
  ) => ManagedStream<U, F>;
  readonly createDeferred: <T>(factory: (scope: Self) => Promise<T>) => Deferred<T>;
  readonly wrapDeferred: <T, U>(inner: Deferred<T>, factory: (inner: Deferred<T>, scope: Self) => Promise<U>) => Deferred<U>;
}

interface Scope<S> extends CommonScope<S>, ProducerMethods<Scope<S>> {}

interface ThroughScope<Down, Up, S> extends CommonScope<S>, ProducerMethods<ThroughScope<Down, Up, S>> {
  readonly next: Next<Down, Up>;
}

interface IntoScope<Calls, S> extends CommonScope<S>, ProducerMethods<IntoScope<Calls, S>> {
  readonly into: Calls;
}

type IntoDeclarations<K extends string> = Readonly<Record<string, Through<K>>>;
type IntoCalls<Space, D extends IntoDeclarations<string>> = {
  readonly [K in keyof D]: Next<Handoff<Space, D[K]['request']>, FactShape<Space, D[K]['response']['needs'][number]>>;
};

type ReturnFacts<Space, R> = R extends Return ? FactShape<Space, R['provides'][number]> : never;
type ThroughAnswers<Space, D extends Through> = FactShape<Space, D['response']['needs'][number]>;
type RequestNeeds<K extends string> = { readonly needs: KeyList<K> };

declare const stageServices: unique symbol;

export interface Stage<in S> {
  readonly name: string;
  readonly [stageServices]: (services: S) => void;
}

interface DefineStage<Space, S> {
  <const D extends Through<FactKey<Space>>, const R extends Return<FactKey<Space>> | undefined = undefined>(options: {
    readonly name: string;
    readonly through: D;
    readonly request?: never;
    readonly into?: never;
    readonly return?: R;
    readonly execute: (
      facts: FactShape<Space, D['request']['needs'][number]>,
      scope: ThroughScope<Handoff<Space, D['request']>, ThroughAnswers<Space, D>, S>,
    ) => Promise<Handoff<Space, D['response']> | ReturnFacts<Space, R>>;
  }): Stage<S>;
  <
    const N extends RequestNeeds<FactKey<Space>>,
    const D extends IntoDeclarations<FactKey<Space>>,
    const R extends Return<FactKey<Space>> | undefined = undefined,
  >(options: {
    readonly name: string;
    readonly request: N;
    readonly into: D;
    readonly through?: never;
    readonly return?: R;
    readonly execute: (
      facts: FactShape<Space, N['needs'][number]>,
      scope: IntoScope<IntoCalls<Space, D>, S>,
    ) => Promise<{ [K in keyof D]: Handoff<Space, D[K]['response']> }[keyof D] | ReturnFacts<Space, R>>;
  }): Stage<S>;
  <const N extends RequestNeeds<FactKey<Space>>, const R extends Return<FactKey<Space>>>(options: {
    readonly name: string;
    readonly request: N;
    readonly through?: never;
    readonly into?: never;
    readonly return: R;
    readonly execute: (facts: FactShape<Space, N['needs'][number]>, scope: Scope<S>) => Promise<ReturnFacts<Space, R>>;
  }): Stage<S>;
}

export interface StageDefinition {
  readonly name: string;
  readonly requestNeeds: Keys;
  readonly through?: ParsedThrough;
  readonly into?: ReadonlyMap<string, ParsedThrough>;
  readonly answer?: Keys;
  readonly execute: (facts: Facts, scope: never) => Promise<Facts>;
}

const definitions = new WeakMap<object, StageDefinition>();

export const definitionOf = (stage: Stage<never>): StageDefinition => {
  const definition = definitions.get(stage);
  if (!definition) throw new TypeError(`Expected a defined stage "${stage.name}"`);
  return definition;
};

interface StageOptions {
  readonly name: string;
  readonly request?: RequestNeeds<string>;
  readonly through?: Through;
  readonly into?: IntoDeclarations<string>;
  readonly return?: Return;
  readonly execute: StageDefinition['execute'];
}

export const defineStageFor = <Space, S>(): DefineStage<Space, S> => ((options: StageOptions) => {
  const { name, execute } = options;
  const through = options.through && parseThrough(options.through, name);
  const into = options.into && new Map(Object.entries(options.into)
    .map(([target, declaration]) => [target, parseThrough(declaration, `${name} into "${target}"`)]));
  const answer = options.return && parseKeys(options.return.provides, `${name} return provides`);
  if ((!through && !into && !answer) || (through && into) || into?.size === 0) {
    throw new TypeError(`Stage "${name}" has an invalid continuation or return declaration`);
  }
  const request = through?.request.needs ?? parseKeys(options.request!.needs, `${name} request needs`);
  const stage = Object.freeze({ name }) as Stage<S>;
  definitions.set(stage, {
    name,
    execute,
    requestNeeds: request,
    ...(through && { through }),
    ...(into && { into }),
    ...(answer && { answer }),
  });
  return stage;
}) as DefineStage<Space, S>;

type TransformSide<I, O> = (facts: I) => O | Promise<O>;
type TransformSides<Rq, Down, Up, Rs> = (
  [Rq] extends [Down] ? { readonly request?: TransformSide<Rq, Down> } : { readonly request: TransformSide<Rq, Down> }
) & (
  [Up] extends [Rs] ? { readonly response?: TransformSide<Up, Rs> } : { readonly response: TransformSide<Up, Rs> }
);

export const transform = <Rq, Down, Up, Rs, S>(
  open: (scope: Scope<S>) => TransformSides<Rq, Down, Up, Rs>,
): ((facts: Rq, scope: ThroughScope<Down, Up, S>) => Promise<Rs>) => async (facts, scope) => {
  const { request, response } = open(scope as Scope<S>);
  const back = await scope.next(request ? await request(facts) : facts as Rq & Down);
  return response ? await response(back) : back as Up & Rs;
};
