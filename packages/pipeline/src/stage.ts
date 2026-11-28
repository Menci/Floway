import type { Logger } from '@guiiai/logg';

import type { Entry } from './compose.ts';
import { parseKeyMap, parseThrough } from './declarations.ts';
import type {
  CheckedKeyMap,
  EdgeHandoff,
  FactShapeFromMap,
  KeyMap,
  Keys,
  OptionalValuesOfMap,
  ParsedThrough,
  RawSide,
  RawThrough,
  RequiredKeysOfMap,
  RequiredValuesOfMap,
  ValuesOfMap,
} from './declarations.ts';
import { isObject } from './facts.ts';
import type { FactSpaceRef } from './space.ts';
import type { Deferred, Facts, Handle, ManagedStream, Read, Result } from './values.ts';

export type Next<Down, Up> = <Actual extends Down>(facts: Actual) => Promise<Up>;

export interface AbortHandle {
  discard(): void;
}

export interface RunCallOptions<S> {
  readonly services: S;
}

export interface WorkerScope<S = object> {
  readonly log: Logger;
  readonly services: Readonly<S>;
}

export interface HostScope {
  readonly signal: AbortSignal;
  readonly read: Read;
  readonly discard: (target: Handle | Promise<unknown>) => void;
  readonly abort: (call: Promise<unknown>, reason?: unknown) => AbortHandle;
  readonly run: <I, O, RS extends object>(
    entry: Entry<I, O, RS>,
    facts: NoInfer<I>,
    options: RunCallOptions<NoInfer<RS>>,
  ) => Promise<O>;
}

export interface RootHostScope extends HostScope {
  close(): void;
}

export interface HostScopeOptions {
  readonly signal: AbortSignal;
  readonly waitUntil: (work: Promise<unknown>) => void;
}

export interface ProducerScope<S = object> extends HostScope, WorkerScope<S> {
  readonly detach: (worker: (scope: WorkerScope<S>) => Promise<unknown>) => void;
  createStream<T, E = never>(
    factory: (producer: this) => AsyncGenerator<Result<T, E>, void, unknown>,
  ): ManagedStream<T, E>;
  wrapStream<T, E, U, F = never>(
    inner: ManagedStream<T, E>,
    factory: (inner: ManagedStream<T, E>, producer: this) => AsyncGenerator<Result<U, F>, void, unknown>,
  ): ManagedStream<U, F>;
  createDeferred<T>(
    factory: (producer: this) => Promise<T>,
  ): Deferred<T>;
  wrapDeferred<T, U>(
    inner: Deferred<T>,
    factory: (inner: Deferred<T>, producer: this) => Promise<U>,
  ): Deferred<U>;
}

interface ThroughStageScope<S, NextFn> extends ProducerScope<S> {
  readonly next: NextFn;
}

interface IntoStageScope<S, IntoMap> extends ProducerScope<S> {
  readonly into: IntoMap;
}

interface FullStageScope<S, NextFn, IntoMap> extends ProducerScope<S> {
  readonly next: NextFn;
  readonly into: IntoMap;
}

export type StageScope<S = object, NextFn = never, IntoMap = never> =
  [NextFn] extends [never]
    ? [IntoMap] extends [never]
        ? ProducerScope<S>
        : IntoStageScope<S, IntoMap>
    : [IntoMap] extends [never]
        ? ThroughStageScope<S, NextFn>
        : FullStageScope<S, NextFn, IntoMap>;

interface RequestNeedsDecl<M extends KeyMap = KeyMap> {
  readonly needs: M;
}

interface ReturnDecl<M extends KeyMap = KeyMap> {
  readonly provides: M;
}

export interface RawIntoEdge {
  readonly target?: FactSpaceRef<any, any, any>;
  readonly request: RawSide;
  readonly response: RawSide;
}

type RawIntoDecl = RawIntoEdge | Readonly<Record<string, RawIntoEdge>>;

type CheckedRequestNeeds<Rq, N> = N extends RequestNeedsDecl<infer M>
  ? { readonly needs: CheckedKeyMap<Rq, M> }
  : unknown;

type CheckedReturn<Rs, R> = R extends ReturnDecl<infer M>
  ? { readonly provides: CheckedKeyMap<Rs, M> }
  : unknown;

type CheckedSide<Space, S> = S extends RawSide
  ? {
      readonly needs: CheckedKeyMap<Space, S['needs']>;
      readonly provides: CheckedKeyMap<Space, S['provides']>;
      readonly consumes: readonly (Exclude<keyof Space & string, keyof S['provides'] & string>)[];
    }
  : never;

type CheckedThrough<Rq, Rs, D> = D extends RawThrough
  ? {
      readonly request: CheckedSide<Rq, D['request']>;
      readonly response: CheckedSide<Rs, D['response']>;
    }
  : unknown;

type EdgeTargetRq<DefaultRq, E> = E extends { readonly target: FactSpaceRef<infer TRq, any, any> } ? TRq : DefaultRq;
type EdgeTargetRs<DefaultRs, E> = E extends { readonly target: FactSpaceRef<any, infer TRs, any> } ? TRs : DefaultRs;

type CheckedIntoEdge<Rq, Rs, E> = E extends RawIntoEdge
  ? {
      readonly target?: FactSpaceRef<any, any, any>;
      readonly request: {
        readonly needs: CheckedKeyMap<Rq, E['request']['needs']>;
        readonly provides: CheckedKeyMap<EdgeTargetRq<Rq, E>, E['request']['provides']>;
        readonly consumes: readonly (Exclude<keyof Rq & string, keyof E['request']['provides'] & string>)[];
      };
      readonly response: {
        readonly needs: CheckedKeyMap<EdgeTargetRs<Rs, E>, E['response']['needs']>;
        readonly provides: CheckedKeyMap<Rs, E['response']['provides']>;
        readonly consumes: readonly (Exclude<keyof EdgeTargetRs<Rs, E> & string, keyof E['response']['provides'] & string>)[];
      };
    }
  : never;

type CheckedIntoMap<Rq, Rs, D> = {
  readonly [K in keyof D]: CheckedIntoEdge<Rq, Rs, D[K]>;
};

type ReturnFacts<Rs, R> = R extends ReturnDecl<infer M> ? FactShapeFromMap<Rs, M> : never;
type ReturnValues<Rs, R> = R extends ReturnDecl<infer M> ? ValuesOfMap<Rs, M> : Record<never, never>;

type IntoCall<Rq, Rs, E extends RawIntoEdge> = Next<
  EdgeHandoff<Rq, EdgeTargetRq<Rq, E>, E['request']['needs'], E['request']['provides'], E['request']['consumes'][number] & string>,
  FactShapeFromMap<EdgeTargetRs<Rs, E>, E['response']['needs']>
>;

type IntoCalls<Rq, Rs, D extends Readonly<Record<string, RawIntoEdge>>> = {
  readonly [K in keyof D]: IntoCall<Rq, Rs, D[K]>;
};

type IntoResponseHandoff<Rs, E extends RawIntoEdge> = EdgeHandoff<
  EdgeTargetRs<Rs, E>,
  Rs,
  E['response']['needs'],
  E['response']['provides'],
  E['response']['consumes'][number] & string
>;

export interface IntoEdgeUses {
  readonly requestConsumes: string;
  readonly requestProvidesRequired: Readonly<Record<string, unknown>>;
  readonly requestProvidesOptional: Readonly<Record<string, unknown>>;
  readonly needs: unknown;
  readonly replaces: string;
}

export type IntoDeclarationUses =
  | { readonly kind: 'none' }
  | { readonly kind: 'homogeneous'; readonly edge: IntoEdgeUses }
  | { readonly kind: 'named'; readonly edges: Readonly<Record<string, IntoEdgeUses>> };

export interface StageUses {
  readonly kind: 'through' | 'into' | 'return';
  readonly requestNeeds: unknown;
  readonly requestProvides: unknown;
  readonly requestProvidesRequired: Readonly<Record<string, unknown>>;
  readonly requestProvidesOptional: Readonly<Record<string, unknown>>;
  readonly requestConsumes: string;
  readonly responseNeeds: unknown;
  readonly responseProvides: unknown;
  readonly responseConsumes: string;
  readonly responseReplaces: string;
  readonly into: IntoDeclarationUses;
}

type EdgeUsesOf<Rq, Rs, E extends RawIntoEdge> = {
  readonly requestConsumes: E['request']['consumes'][number] & string;
  readonly requestProvidesRequired: RequiredValuesOfMap<EdgeTargetRq<Rq, E>, E['request']['provides']>;
  readonly requestProvidesOptional: OptionalValuesOfMap<EdgeTargetRq<Rq, E>, E['request']['provides']>;
  readonly needs: FactShapeFromMap<EdgeTargetRs<Rs, E>, E['response']['needs']>;
  readonly replaces: RequiredKeysOfMap<E['response']['provides']> | (E['response']['consumes'][number] & string);
};

type UnionToIntersection<U> = (U extends unknown ? (value: U) => void : never) extends (value: infer I) => void ? I : never;

type ThroughStageUses<Rq, Rs, D extends RawThrough, R> = {
  readonly kind: 'through';
  readonly requestNeeds: ValuesOfMap<Rq, D['request']['needs']>;
  readonly requestProvides: ValuesOfMap<Rq, D['request']['provides']>;
  readonly requestProvidesRequired: RequiredValuesOfMap<Rq, D['request']['provides']>;
  readonly requestProvidesOptional: OptionalValuesOfMap<Rq, D['request']['provides']>;
  readonly requestConsumes: D['request']['consumes'][number] & string;
  readonly responseNeeds: ValuesOfMap<Rs, D['response']['needs']>;
  readonly responseProvides: ValuesOfMap<Rs, D['response']['provides']> & ReturnValues<Rs, R>;
  readonly responseConsumes: D['response']['consumes'][number] & string;
  readonly responseReplaces: RequiredKeysOfMap<D['response']['provides']> | (D['response']['consumes'][number] & string);
  readonly into: { readonly kind: 'none' };
};

type HomogeneousIntoStageUses<Rq, Rs, N extends RequestNeedsDecl, E extends RawIntoEdge, R> = {
  readonly kind: 'into';
  readonly requestNeeds: ValuesOfMap<Rq, N['needs']> & ValuesOfMap<Rq, E['request']['needs']>;
  readonly requestProvides: Record<never, never>;
  readonly requestProvidesRequired: Record<never, never>;
  readonly requestProvidesOptional: Record<never, never>;
  readonly requestConsumes: never;
  readonly responseNeeds: Record<never, never>;
  readonly responseProvides: ValuesOfMap<Rs, E['response']['provides']> & ReturnValues<Rs, R>;
  readonly responseConsumes: never;
  readonly responseReplaces: never;
  readonly into: { readonly kind: 'homogeneous'; readonly edge: EdgeUsesOf<Rq, Rs, E> };
};

type NamedIntoStageUses<Rq, Rs, N extends RequestNeedsDecl, D extends Readonly<Record<string, RawIntoEdge>>, R> = {
  readonly kind: 'into';
  readonly requestNeeds: ValuesOfMap<Rq, N['needs']> & UnionToIntersection<{ [K in keyof D]: ValuesOfMap<Rq, D[K]['request']['needs']> }[keyof D]>;
  readonly requestProvides: Record<never, never>;
  readonly requestProvidesRequired: Record<never, never>;
  readonly requestProvidesOptional: Record<never, never>;
  readonly requestConsumes: never;
  readonly responseNeeds: Record<never, never>;
  readonly responseProvides: UnionToIntersection<{ [K in keyof D]: ValuesOfMap<Rs, D[K]['response']['provides']> }[keyof D]> & ReturnValues<Rs, R>;
  readonly responseConsumes: never;
  readonly responseReplaces: never;
  readonly into: {
    readonly kind: 'named';
    readonly edges: { readonly [K in keyof D]: EdgeUsesOf<Rq, Rs, D[K]> };
  };
};

type ReturnOnlyStageUses<Rq, Rs, N extends RequestNeedsDecl, R extends ReturnDecl> = {
  readonly kind: 'return';
  readonly requestNeeds: ValuesOfMap<Rq, N['needs']>;
  readonly requestProvides: Record<never, never>;
  readonly requestProvidesRequired: Record<never, never>;
  readonly requestProvidesOptional: Record<never, never>;
  readonly requestConsumes: never;
  readonly responseNeeds: Record<never, never>;
  readonly responseProvides: ReturnValues<Rs, R>;
  readonly responseConsumes: never;
  readonly responseReplaces: never;
  readonly into: { readonly kind: 'none' };
};

declare const stageType: unique symbol;

export interface Stage<in S, out Used extends StageUses = StageUses> {
  readonly name: string;
  readonly [stageType]: { readonly services: (services: S) => void; readonly used: Used };
}

export interface DefineStage<Rq, Rs, S> {
  <const NM extends KeyMap, const RM extends KeyMap>(options: {
    readonly name: string;
    readonly request: { readonly needs: NM & CheckedKeyMap<Rq, NoInfer<NM>> };
    readonly through?: never;
    readonly into?: never;
    readonly return: { readonly provides: RM & CheckedKeyMap<Rs, NoInfer<RM>> };
    readonly execute: (
      facts: FactShapeFromMap<Rq, NoInfer<NM>>,
      scope: StageScope<S>,
    ) => Promise<FactShapeFromMap<Rs, NoInfer<RM>>>;
  }): Stage<S, ReturnOnlyStageUses<Rq, Rs, { readonly needs: NM }, { readonly provides: RM }>>;

  <const N extends RequestNeedsDecl, const E extends RawIntoEdge, const R extends ReturnDecl | undefined = undefined>(options: {
    readonly name: string;
    readonly request: N & CheckedRequestNeeds<Rq, NoInfer<N>>;
    readonly into: E & CheckedIntoEdge<Rq, Rs, NoInfer<E>>;
    readonly through?: never;
    readonly return?: R & CheckedReturn<Rs, NoInfer<R>>;
    readonly execute: (
      facts: FactShapeFromMap<Rq, NoInfer<N>['needs']>,
      scope: StageScope<S, never, Readonly<Record<string, IntoCall<Rq, Rs, NoInfer<E>>>>>,
    ) => Promise<IntoResponseHandoff<Rs, NoInfer<E>> | ReturnFacts<Rs, NoInfer<R>>>;
  }): Stage<S, HomogeneousIntoStageUses<Rq, Rs, N, E, R>>;

  <
    const N extends RequestNeedsDecl,
    const D extends Readonly<Record<string, RawIntoEdge>>,
    const R extends ReturnDecl | undefined = undefined,
  >(options: {
    readonly name: string;
    readonly request: N & CheckedRequestNeeds<Rq, NoInfer<N>>;
    readonly into: D & CheckedIntoMap<Rq, Rs, NoInfer<D>>;
    readonly through?: never;
    readonly return?: R & CheckedReturn<Rs, NoInfer<R>>;
    readonly execute: (
      facts: FactShapeFromMap<Rq, NoInfer<N>['needs']>,
      scope: StageScope<S, never, IntoCalls<Rq, Rs, NoInfer<D>>>,
    ) => Promise<{ [K in keyof NoInfer<D>]: IntoResponseHandoff<Rs, NoInfer<D>[K]> }[keyof NoInfer<D>] | ReturnFacts<Rs, NoInfer<R>>>;
  }): Stage<S, NamedIntoStageUses<Rq, Rs, N, D, R>>;

  <const D extends RawThrough, const R extends ReturnDecl | undefined = undefined>(options: {
    readonly name: string;
    readonly through: D & CheckedThrough<Rq, Rs, NoInfer<D>>;
    readonly request?: never;
    readonly into?: never;
    readonly return?: R & CheckedReturn<Rs, NoInfer<R>>;
    readonly execute: (
      facts: FactShapeFromMap<Rq, NoInfer<D>['request']['needs']>,
      scope: StageScope<
        S,
        Next<
          EdgeHandoff<
            Rq,
            Rq,
            NoInfer<D>['request']['needs'],
            NoInfer<D>['request']['provides'],
            NoInfer<D>['request']['consumes'][number] & string
          >,
          FactShapeFromMap<Rs, NoInfer<D>['response']['needs']>
        >
      >,
    ) => Promise<
      | EdgeHandoff<
        Rs,
        Rs,
        NoInfer<D>['response']['needs'],
        NoInfer<D>['response']['provides'],
        NoInfer<D>['response']['consumes'][number] & string
      >
      | ReturnFacts<Rs, NoInfer<R>>
    >;
  }): Stage<S, ThroughStageUses<Rq, Rs, D, R>>;
}

export type ParsedInto =
  | { readonly kind: 'named'; readonly edges: ReadonlyMap<string, ParsedThrough> }
  | { readonly kind: 'homogeneous'; readonly edge: ParsedThrough };

export interface StageDefinition {
  readonly name: string;
  readonly requestNeeds: Keys;
  readonly through?: ParsedThrough;
  readonly into?: ParsedInto;
  readonly answer?: Keys;
  readonly execute: (facts: Facts, scope: never) => Promise<Facts>;
}

const definitions = new WeakMap<object, StageDefinition>();

export const definitionOf = (stage: Stage<never>): StageDefinition => {
  const definition = isObject(stage) ? definitions.get(stage) : undefined;
  if (!definition) {
    const label = isObject(stage) && typeof (stage as { name?: unknown }).name === 'string'
      ? ` "${(stage as { name: string }).name}"`
      : '';
    throw new TypeError(`Expected a defined stage${label}`);
  }
  return definition;
};

interface StageOptions {
  readonly name: string;
  readonly request?: RequestNeedsDecl;
  readonly through?: RawThrough;
  readonly into?: RawIntoDecl;
  readonly return?: ReturnDecl;
  readonly execute: StageDefinition['execute'];
}

const isRawSide = (value: unknown): value is RawSide =>
  typeof value === 'object'
  && value !== null
  && !Array.isArray(value)
  && 'needs' in value
  && 'provides' in value
  && 'consumes' in value;

const isSingleIntoEdge = (value: unknown): value is RawIntoEdge =>
  typeof value === 'object'
  && value !== null
  && !Array.isArray(value)
  && 'request' in value
  && 'response' in value
  && isRawSide((value as { request?: unknown }).request)
  && isRawSide((value as { response?: unknown }).response);

const parseInto = (into: StageOptions['into'], name: string): ParsedInto | undefined => {
  if (!into) return undefined;
  if (typeof into !== 'object' || Array.isArray(into)) {
    throw new TypeError(`Stage "${name}" has an invalid into declaration`);
  }
  if (isSingleIntoEdge(into)) {
    return { kind: 'homogeneous', edge: parseThrough(into, `${name} into`) };
  }
  if (Object.getOwnPropertySymbols(into).length > 0) {
    throw new TypeError(`Stage "${name}" into declaration must not contain symbol keys`);
  }
  const names = Object.getOwnPropertyNames(into);
  if (names.length === 0) {
    throw new TypeError(`Stage "${name}" has an empty into declaration`);
  }
  const edges = new Map<string, ParsedThrough>();
  for (const target of names) {
    const descriptor = Object.getOwnPropertyDescriptor(into, target);
    if (!descriptor || !('value' in descriptor) || !isSingleIntoEdge(descriptor.value)) {
      throw new TypeError(`Stage "${name}" into target "${target}" has an invalid edge declaration`);
    }
    edges.set(target, parseThrough(descriptor.value, `${name} into "${target}"`));
  }
  return { kind: 'named', edges };
};

export const defineStageFor = <Rq, Rs, S>(): DefineStage<Rq, Rs, S> => ((options: StageOptions) => {
  const { name, execute } = options;
  if (typeof name !== 'string' || !name) throw new TypeError('Stage name must be a non-empty string');
  const through = options.through && parseThrough(options.through, name);
  const into = parseInto(options.into, name);
  const answer = options.return && parseKeyMap(options.return.provides, `${name} return provides`);
  if ((!through && !into && !answer) || (through && into)) {
    throw new TypeError(`Stage "${name}" has an invalid continuation or return declaration`);
  }
  let requestNeeds: Keys;
  if (through) {
    requestNeeds = through.request.needs;
  } else {
    if (!options.request || typeof options.request !== 'object') {
      throw new TypeError(`Stage "${name}" requires a request declaration`);
    }
    requestNeeds = parseKeyMap(options.request.needs, `${name} request needs`);
  }
  const stage = Object.freeze({ name }) as Stage<S, never>;
  definitions.set(stage, {
    name,
    execute,
    requestNeeds,
    ...(through && { through }),
    ...(into && { into }),
    ...(answer && { answer }),
  });
  return stage;
}) as unknown as DefineStage<Rq, Rs, S>;

type TransformSide<I, O> = (facts: I) => O | Promise<O>;
type TransformSides<Rq, Down, Up, Rs> = (
  [Rq] extends [Down] ? { readonly request?: TransformSide<Rq, Down> } : { readonly request: TransformSide<Rq, Down> }
) & (
  [Up] extends [Rs] ? { readonly response?: TransformSide<Up, Rs> } : { readonly response: TransformSide<Up, Rs> }
);

export const transform = <Rq, Down, Up, Rs, S>(
  open: (scope: ProducerScope<S>) => TransformSides<Rq, Down, Up, Rs>,
): ((facts: Rq, scope: StageScope<S, Next<Down, Up>>) => Promise<Rs>) => async (facts, scope) => {
  const { request, response } = open(scope);
  const back = await scope.next(request ? await request(facts) : facts as Rq & Down);
  return response ? await response(back) : back as Up & Rs;
};
