import type { Logger } from '@guiiai/logg';

import type { Entry } from './compose.ts';
import { parseKeys, parseThrough } from './declarations.ts';
import type { FactKey, FactShape, Handoff, KeyList, Keys, ParsedThrough, Return, Side, Through, Unmarked } from './declarations.ts';
import type { Deferred, Facts, Handle, ManagedStream, Read, Result } from './values.ts';

type Next<Down, Up> = <Actual extends Down>(facts: Actual) => Promise<Up>;

interface WorkerScope<S> {
  readonly log: Logger;
  readonly services: Readonly<S>;
}

interface CommonScope<S> extends WorkerScope<S> {
  readonly signal: AbortSignal;
  readonly abort: (promise: Promise<unknown>) => void;
  readonly run: <I, O>(entry: Entry<I, O, S>, facts: NoInfer<I>) => Promise<O>;
  readonly read: Read;
  readonly discard: (value: Handle | Facts) => void;
  readonly detach: (worker: (scope: WorkerScope<S>) => Promise<unknown>) => void;
}

interface ProducerMethods<Self> {
  readonly createStream: <T, E = never>(factory: (scope: Self) => AsyncGenerator<Result<T, E>, void, unknown>) => ManagedStream<T, E>;
  readonly wrapStream: <T, E, U, F = never>(
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

type IntoDeclarations<Rq extends string = string, Rs extends string = string> = Readonly<Record<string, Through<Rq, Rs>>>;
type IntoCalls<Rq, Rs, D extends IntoDeclarations> = {
  readonly [K in keyof D]: Next<Handoff<Rq, D[K]['request']>, FactShape<Rs, D[K]['response']['needs'][number]>>;
};

type ReturnKeys<R> = R extends Return ? R['provides'][number] : never;
type ReturnFacts<Rs, R> = R extends Return ? FactShape<Rs, ReturnKeys<R>> : never;
type RequestNeeds<K extends string> = { readonly needs: KeyList<K> };

type Values<Space, K> = Pick<Required<Space>, Unmarked<K> & keyof Space>;
type RequiredProvides<D extends Return> = Exclude<D['provides'][number], `${string}?`>;
type MissingProvide<D, K> = D extends Return ? Exclude<K, RequiredProvides<D>> : never;
type MissingConsume<D, K> = D extends Side ? Exclude<K, D['consumes'][number]> : never;

type Replaced<D extends Side, R> =
  | Exclude<RequiredProvides<D>, MissingProvide<D | R, RequiredProvides<D>>>
  | Exclude<D['consumes'][number], MissingConsume<D, D['consumes'][number]> | Unmarked<ReturnKeys<R>>>;

export interface IntoUses {
  readonly requestConsumes: string;
  readonly requestProvides: string;
  readonly needs: unknown;
  readonly replaces: string;
}

export interface StageUses {
  readonly requestNeeds: unknown;
  readonly requestProvides: unknown;
  readonly requestConsumes: string;
  readonly responseNeeds: unknown;
  readonly responseProvides: unknown;
  readonly responseReplaces: string;
  readonly into: Readonly<Record<string, IntoUses>>;
}

type Uses<Rq, Rs, N, D extends Through, R, I = Record<never, never>> = {
  readonly requestNeeds: Values<Rq, N | D['request']['needs'][number]>;
  readonly requestProvides: Values<Rq, D['request']['provides'][number]>;
  readonly requestConsumes: D['request']['consumes'][number];
  readonly responseNeeds: Values<Rs, D['response']['needs'][number]>;
  readonly responseProvides: Values<Rs, D['response']['provides'][number] | ReturnKeys<R>>;
  readonly responseReplaces: Replaced<D['response'], R>;
  readonly into: I;
};

type NoContinuation = Through<never, never>;

declare const stageType: unique symbol;

export interface Stage<in S, out Used extends StageUses = StageUses> {
  readonly name: string;
  readonly [stageType]: { readonly services: (services: S) => void; readonly used: Used };
}

interface DefineStage<Rq, Rs, S> {
  <const D extends Through<FactKey<Rq>, FactKey<Rs>>, const R extends Return<FactKey<Rs>> | undefined = undefined>(options: {
    readonly name: string;
    readonly through: D;
    readonly request?: never;
    readonly into?: never;
    readonly return?: R;
    readonly execute: (
      facts: FactShape<Rq, D['request']['needs'][number]>,
      scope: ThroughScope<Handoff<Rq, D['request']>, FactShape<Rs, D['response']['needs'][number]>, S>,
    ) => Promise<Handoff<Rs, D['response']> | ReturnFacts<Rs, R>>;
  }): Stage<S, Uses<Rq, Rs, never, D, R>>;
  <
    const N extends RequestNeeds<FactKey<Rq>>,
    const D extends IntoDeclarations<FactKey<Rq>, FactKey<Rs>>,
    const R extends Return<FactKey<Rs>> | undefined = undefined,
  >(options: {
    readonly name: string;
    readonly request: N;
    readonly into: D;
    readonly through?: never;
    readonly return?: R;
    readonly execute: (
      facts: FactShape<Rq, N['needs'][number]>,
      scope: IntoScope<IntoCalls<Rq, Rs, D>, S>,
    ) => Promise<{ [K in keyof D]: Handoff<Rs, D[K]['response']> }[keyof D] | ReturnFacts<Rs, R>>;
  }): Stage<S, Uses<Rq, Rs, N['needs'][number], D[keyof D], R, {
    readonly [K in keyof D]: {
      readonly requestConsumes: D[K]['request']['consumes'][number];
      readonly requestProvides: Unmarked<D[K]['request']['provides'][number]>;
      readonly needs: FactShape<Rs, D[K]['response']['needs'][number]>;
      readonly replaces: Replaced<D[keyof D]['response'], R>;
    };
  }>>;
  <const N extends RequestNeeds<FactKey<Rq>>, const R extends Return<FactKey<Rs>>>(options: {
    readonly name: string;
    readonly request: N;
    readonly through?: never;
    readonly into?: never;
    readonly return: R;
    readonly execute: (facts: FactShape<Rq, N['needs'][number]>, scope: Scope<S>) => Promise<ReturnFacts<Rs, R>>;
  }): Stage<S, Uses<Rq, Rs, N['needs'][number], NoContinuation, R>>;
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
  readonly into?: IntoDeclarations;
  readonly return?: Return;
  readonly execute: StageDefinition['execute'];
}

export const defineStageFor = <Rq, Rs, S>(): DefineStage<Rq, Rs, S> => ((options: StageOptions) => {
  const { name, execute } = options;
  const through = options.through && parseThrough(options.through, name);
  const into = options.into && new Map(Object.entries(options.into)
    .map(([target, declaration]) => [target, parseThrough(declaration, `${name} into "${target}"`)]));
  const answer = options.return && parseKeys(options.return.provides, `${name} return provides`);
  if ((!through && !into && !answer) || (through && into) || into?.size === 0) {
    throw new TypeError(`Stage "${name}" has an invalid continuation or return declaration`);
  }
  const request = through?.request.needs ?? parseKeys(options.request!.needs, `${name} request needs`);
  const stage = Object.freeze({ name }) as Stage<S, never>;
  definitions.set(stage, {
    name,
    execute,
    requestNeeds: request,
    ...(through && { through }),
    ...(into && { into }),
    ...(answer && { answer }),
  });
  return stage;
}) as DefineStage<Rq, Rs, S>;

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
