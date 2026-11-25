import type { Logger } from '@guiiai/logg';

import type { Pipeline } from './compose.ts';
import { parseKeys, parseThrough } from './declarations.ts';
import type { KeyList, Keys, ParsedThrough, Return, Side, Through } from './declarations.ts';
import type { Facts } from './facts.ts';
import type { DeferredController, ManagedStream, Result } from './values.ts';

export type FactKey<Space> = (keyof Space & string) | `${keyof Space & string}?`;
type Unmarked<K> = K extends `${infer Key}?` ? Key : K;
type RequiredKeys<K> = Exclude<K, `${string}?`>;
type Without<K, Removed> = K extends string ? Unmarked<K> extends Removed ? never : K : never;

export type FactShape<Space, K> = {
  readonly [Key in RequiredKeys<K> & keyof Space]-?: Required<Space>[Key];
} & {
  readonly [Key in Exclude<Unmarked<K>, RequiredKeys<K>> & keyof Space]?: Required<Space>[Key];
};

type Handoff<Space, D extends Side> = FactShape<Space,
  D['provides'][number] | Without<D['needs'][number], Unmarked<D['consumes'][number]>>
> & { readonly [K in Unmarked<D['consumes'][number]>]?: never };

type Next<Down, Up> = <Actual extends Down>(facts: Actual) => Promise<Up>;

interface StreamMethods<Self> {
  readonly createStream: <T, E>(iterate: (scope: Self) => AsyncIterable<Result<T, E>>) => ManagedStream<T, E>;
  readonly wrapStream: <T, E, U, F>(
    source: ManagedStream<T, E>,
    transform: (source: AsyncIterable<Result<T, E>>, scope: Self) => AsyncIterable<Result<U, F>>,
  ) => ManagedStream<U, F>;
}

interface CommonScope<S> {
  readonly signal: AbortSignal;
  readonly services: Readonly<S>;
  readonly log: Logger;
  readonly abort: (key: object) => void;
  readonly run: <I, O>(pipeline: Pipeline<I, O, S>, facts: NoInfer<I>) => Promise<O>;
  readonly deferred: <T>() => DeferredController<T>;
  readonly defer: (work: Promise<unknown>) => void;
}

interface Scope<S> extends CommonScope<S>, StreamMethods<Scope<S>> {}

interface ThroughScope<Down, Up, S> extends CommonScope<S>, StreamMethods<ThroughScope<Down, Up, S>> {
  readonly next: Next<Down, Up>;
}

interface IntoScope<Calls, S> extends CommonScope<S>, StreamMethods<IntoScope<Calls, S>> {
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
  readonly [stageServices]?: (services: S) => void;
}

interface DefineStage<Space, S> {
  <const D extends Through<FactKey<Space>>, const R extends Return<FactKey<Space>> | undefined = undefined>(options: {
    readonly name: string;
    readonly through: D;
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
    readonly return?: R;
    readonly execute: (
      facts: FactShape<Space, N['needs'][number]>,
      scope: IntoScope<IntoCalls<Space, D>, S>,
    ) => Promise<{ [K in keyof D]: Handoff<Space, D[K]['response']> }[keyof D] | ReturnFacts<Space, R>>;
  }): Stage<S>;
  <const N extends RequestNeeds<FactKey<Space>>, const R extends Return<FactKey<Space>>>(options: {
    readonly name: string;
    readonly request: N;
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
  const requestNeeds = through?.request.needs ?? parseKeys(options.request!.needs, `${name} request needs`);
  const stage = Object.freeze({ name });
  definitions.set(stage, {
    name,
    execute,
    requestNeeds,
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
