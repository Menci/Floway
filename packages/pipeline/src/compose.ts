import { parseKeyMap } from './declarations.ts';
import type {
  CheckedKeyMap,
  ExactEqual,
  FactShapeFromMap,
  KeyMap,
  Keys,
  OptionalKeysOfMap,
  ParsedSide,
  ParsedThrough,
  RequiredKeysOfMap,
} from './declarations.ts';
import { isObject } from './facts.ts';
import { definitionOf } from './stage.ts';
import type { IntoDeclarationUses, IntoEdgeUses, Stage, StageDefinition, StageUses } from './stage.ts';

declare const pipelineType: unique symbol;
declare const entryType: unique symbol;

export interface PipelineReference<in S> {
  readonly name: string;
  readonly [pipelineType]: { readonly services: (services: S) => void };
}

export interface PipelineContract<in I, out O, in S, out IK, out OK> extends PipelineReference<S> {
  readonly [pipelineType]: PipelineReference<S>[typeof pipelineType] & {
    readonly invoke: (facts: I) => O;
    readonly inputKeys: IK;
    readonly outputKeys: OK;
  };
}

export type Pipeline<I, O, S = object> = PipelineContract<I, O, S, keyof I, keyof O>;

export interface Entry<I, O, S = object> extends Pipeline<I, O, S> {
  readonly [entryType]: true;
}

type TargetSource<S> = PipelineReference<S> | (() => PipelineReference<S>);
type Targets<S> = Readonly<Record<string, TargetSource<S>>>;

type MatchesSpace<Space, Used> = [keyof Used] extends [keyof Space]
  ? false extends {
    [K in keyof Used & keyof Space]: ExactEqual<Used[K], Space[K]>;
  }[keyof Used & keyof Space]
    ? false
    : true
  : false;

type Writes<Space, Used> = [keyof Used] extends [keyof Space]
  ? [Used] extends [Pick<Required<Space>, keyof Used & keyof Space>] ? true : false
  : false;

type KnownKeys<K> = string extends K ? never : K;

type IntoRequestConsumes<I extends IntoDeclarationUses> =
  I extends { readonly kind: 'homogeneous'; readonly edge: infer U extends IntoEdgeUses }
    ? KnownKeys<U['requestConsumes']>
    : I extends { readonly kind: 'named'; readonly edges: infer Edges extends Readonly<Record<string, IntoEdgeUses>> }
      ? KnownKeys<Edges[keyof Edges]['requestConsumes']>
      : never;

type ConsumesInSpace<Space, Consumed> = [KnownKeys<Consumed>] extends [keyof Space] ? true : false;

type CheckStageValues<Rq, Rs, Used extends StageUses> = false extends
  | MatchesSpace<Rq, Used['requestNeeds']>
  | MatchesSpace<Rq, Used['requestProvides']>
  | ConsumesInSpace<Rq, Used['requestConsumes']>
  | ConsumesInSpace<Rq, IntoRequestConsumes<Used['into']>>
  | MatchesSpace<Rs, Used['responseNeeds']>
  | MatchesSpace<Rs, Used['responseProvides']>
  | ConsumesInSpace<Rs, Used['responseConsumes']>
  ? false
  : true;

type CheckThroughStage<Rq, Rs, T> = T extends Stage<never, infer Used>
  ? Used['kind'] extends 'through'
    ? CheckStageValues<Rq, Rs, Used> extends true ? T : never
    : never
  : never;

type CheckEndingStage<Rq, Rs, T> = T extends Stage<never, infer Used>
  ? Used['kind'] extends 'into' | 'return'
    ? CheckStageValues<Rq, Rs, Used> extends true ? T : never
    : never
  : never;

type StageList<Rq, Rs, L extends readonly Stage<never>[]> = { [K in keyof L]: CheckThroughStage<Rq, Rs, L[K]> };

type RequiredProperties<T> = { [K in keyof T]-?: object extends Pick<T, K> ? never : K }[keyof T];
type Satisfies<Have, Need, Shared extends keyof Have & keyof Need = keyof Have & keyof Need> =
  [Pick<Have, Shared>] extends [Pick<Need, RequiredProperties<Need> | Shared>] ? true : false;

type StageReqCons<T> = T extends Stage<never, infer U> ? KnownKeys<U['requestConsumes']> : never;
type StageReqProvReq<T> = T extends Stage<never, infer U> ? keyof U['requestProvidesRequired'] & string : never;
type StageReqProvOpt<T> = T extends Stage<never, infer U> ? keyof U['requestProvidesOptional'] & string : never;

type AdvanceReqState<
  L extends readonly unknown[],
  Req extends string,
  Opt extends string,
  Abs extends string,
> = L extends readonly [infer H, ...infer T]
  ? AdvanceReqState<
    T,
    Exclude<Req, StageReqCons<H>> | StageReqProvReq<H>,
    Exclude<Exclude<Opt, StageReqCons<H>> | StageReqProvOpt<H>, Exclude<Req, StageReqCons<H>> | StageReqProvReq<H>>,
    Exclude<Abs | StageReqCons<H>, StageReqProvReq<H> | StageReqProvOpt<H>>
  >
  : L extends readonly []
    ? readonly [Req, Opt, Abs]
    : readonly [
      Exclude<Req, StageReqCons<L[number]>>,
      Exclude<Opt | StageReqProvReq<L[number]> | StageReqProvOpt<L[number]>, Exclude<Req, StageReqCons<L[number]>>>,
      Exclude<Abs, StageReqProvReq<L[number]> | StageReqProvOpt<L[number]>>,
    ];

type ResponseNeeds<T> = T extends Stage<never, infer U> ? keyof U['responseNeeds'] : never;
type BeforeResponse<T, K> = T extends Stage<never, infer U>
  ? Exclude<K, KnownKeys<U['responseReplaces']>> | ResponseNeeds<T>
  : K;

// Every returned value needed below a stage is either supplied there or checked further upstream.
type TargetResponseNeeds<L extends readonly unknown[], K> = L extends readonly [infer H, ...infer T]
  ? TargetResponseNeeds<T, BeforeResponse<H, K>>
  : K | ResponseNeeds<L[number]>;

type EdgeReqValue<
  Rq,
  U extends IntoEdgeUses,
  K extends string,
  PrePresent extends string,
> = K extends keyof U['requestProvidesRequired']
  ? U['requestProvidesRequired'][K]
  : K extends keyof U['requestProvidesOptional']
    ? K extends PrePresent & keyof Rq
      ? Rq[K] | U['requestProvidesOptional'][K]
      : U['requestProvidesOptional'][K]
    : K extends keyof Rq
      ? Rq[K]
      : never;

type EdgeSupplied<
  Rq,
  U extends IntoEdgeUses,
  Req extends string,
  Opt extends string,
  EdgeCons extends string = KnownKeys<U['requestConsumes']>,
  ProvReq extends string = keyof U['requestProvidesRequired'] & string,
  ProvOpt extends string = keyof U['requestProvidesOptional'] & string,
  PrePresent extends string = Exclude<Req | Opt, EdgeCons>,
  FinalReq extends string = Exclude<Req, EdgeCons> | ProvReq,
  FinalOpt extends string = Exclude<Exclude<Opt, EdgeCons> | ProvOpt, FinalReq>,
> = {
  readonly [K in FinalReq]-?: EdgeReqValue<Rq, U, K, PrePresent>;
} & {
  readonly [K in FinalOpt]?: EdgeReqValue<Rq, U, K, PrePresent>;
};

type CheckInput<
  Rq,
  I,
  IK,
  State extends readonly [string, string, string],
  U extends IntoEdgeUses,
  EdgeCons extends string = KnownKeys<U['requestConsumes']>,
  ProvReq extends string = keyof U['requestProvidesRequired'] & string,
  ProvOpt extends string = keyof U['requestProvidesOptional'] & string,
  FinalPresent extends string = Exclude<State[0] | State[1], EdgeCons> | ProvReq | ProvOpt,
  FinalAbsent extends string = Exclude<State[2] | EdgeCons, ProvReq | ProvOpt>,
> = [IK] extends [FinalPresent | FinalAbsent]
  ? [Pick<EdgeSupplied<Rq, U, State[0], State[1]>, IK & FinalPresent>] extends [I]
      ? true
      : false
  : false;

type CheckOutput<Rs, O, OK, K, U extends IntoEdgeUses> = false extends
  | Satisfies<O, U['needs']>
  | Writes<Rs, Pick<Required<O>, OK & keyof O & Exclude<K, KnownKeys<U['replaces']>>>>
  ? false
  : true;

type Resolved<T> = T extends () => infer P ? P : T;
type CheckTarget<Rq, Rs, State extends readonly [string, string, string], K, T, U extends IntoEdgeUses> =
  Resolved<T> extends PipelineContract<infer I, infer O, never, infer IK, infer OK>
    ? false extends CheckInput<Rq, I, IK, State, U> | CheckOutput<Rs, O, OK, K, U>
      ? never
      : T
    : never;

type TargetsUsed<E> = E extends Stage<never, infer Used> ? Used['into'] : { readonly kind: 'none' };

type CheckTargets<Rq, Rs, State extends readonly [string, string, string], Need, E, T> =
  TargetsUsed<E> extends { readonly kind: 'homogeneous'; readonly edge: infer U extends IntoEdgeUses }
    ? { readonly [K in keyof T]: CheckTarget<Rq, Rs, State, Need, T[K], U> }
    : TargetsUsed<E> extends { readonly kind: 'named'; readonly edges: infer Edges extends Readonly<Record<string, IntoEdgeUses>> }
      ? { readonly [K in keyof T]: K extends keyof Edges ? CheckTarget<Rq, Rs, State, Need, T[K], Edges[K]> : never }
        & { readonly [K in keyof Edges]: K extends keyof T ? unknown : never }
      : { readonly [K in keyof T]: never };

type TargetsRequirement<E> =
  TargetsUsed<E> extends { readonly kind: 'none' }
    ? unknown
    : { readonly targets: unknown };

export interface Compose<Rq, Rs, S> {
  <
    const I extends KeyMap,
    const O extends KeyMap,
    const L extends readonly Stage<S>[],
    const E extends Stage<S>,
    const T extends Targets<S> = Record<never, never>,
  >(name: string, options: {
    readonly entry: I & CheckedKeyMap<Rq, NoInfer<I>>;
    readonly exit: O & CheckedKeyMap<Rs, NoInfer<O>>;
    readonly stages: L & StageList<Rq, Rs, NoInfer<L>>;
    readonly ending: E & CheckEndingStage<Rq, Rs, NoInfer<E>>;
    readonly targets?: T & CheckTargets<
      Rq,
      Rs,
      AdvanceReqState<NoInfer<L>, RequiredKeysOfMap<NoInfer<I>>, OptionalKeysOfMap<NoInfer<I>>, never>,
      TargetResponseNeeds<NoInfer<L>, keyof NoInfer<O> & string>,
      NoInfer<E>,
      NoInfer<T>
    >;
  } & TargetsRequirement<NoInfer<E>>): Pipeline<FactShapeFromMap<Rq, I>, FactShapeFromMap<Rs, O>, S>;
}

interface Target {
  readonly assembly: Assembly;
  readonly declaration: ParsedThrough;
}

export interface Assembly {
  readonly name: string;
  readonly entry: Keys;
  readonly exit: Keys;
  readonly stages: readonly StageDefinition[];
  readonly targets: ReadonlyMap<string, Target>;
}

type Definition = Omit<Assembly, 'targets'> & {
  readonly supplied: ReadonlyMap<string, TargetSource<never>>;
  readonly available: Keys;
  readonly consumed: ReadonlySet<string>;
};

const definitions = new WeakMap<object, Definition>();
const assemblies = new WeakMap<Definition, Assembly>();
const entries = new WeakMap<object, Assembly>();

const pipelineLabel = (value: unknown): string =>
  isObject(value) && typeof (value as { name?: unknown }).name === 'string'
    ? ` "${(value as { name: string }).name}"`
    : '';

export const entryAssembly = (entry: PipelineReference<never> & { readonly [entryType]: true }): Assembly => {
  const assembly = isObject(entry) ? entries.get(entry) : undefined;
  if (!assembly) throw new TypeError(`Expected a checked entry for pipeline${pipelineLabel(entry)}`);
  return assembly;
};

const apply = (available: Map<string, boolean>, declaration: ParsedSide): void => {
  for (const key of declaration.consumes) available.delete(key);
  for (const [key, isRequired] of declaration.provides) {
    available.set(key, isRequired || available.get(key) === true);
  }
};

const requireGuaranteed = (available: Keys, needs: Keys, where: string): void => {
  for (const [key, isRequired] of needs) {
    if (isRequired && available.get(key) !== true) throw new TypeError(`${where} does not guarantee "${key}"`);
  }
};

const join = (paths: readonly Keys[]): Map<string, boolean> => {
  const keys = new Set(paths.flatMap(path => [...path.keys()]));
  return new Map([...keys].map(key => [key, paths.every(path => path.get(key) === true)]));
};

const keysEqual = (left: Keys | undefined, right: Keys | undefined): boolean => {
  if (left === right) return true;
  if (!left || !right || left.size !== right.size) return false;
  for (const [key, value] of left) {
    if (right.get(key) !== value) return false;
  }
  return true;
};

const match = (declared: Keys, derived: Keys, where: string): void => {
  for (const key of new Set([...declared.keys(), ...derived.keys()])) {
    if (declared.get(key) !== derived.get(key)) throw new TypeError(`${where} disagrees with the stages on "${key}"`);
  }
};

const validateRequest = (name: string, entry: Keys, stages: readonly StageDefinition[]) => {
  const external = new Map<string, boolean>();
  const available = new Map<string, boolean>();
  const consumed = new Set<string>();
  const need = (where: string, needs: Keys): void => {
    for (const [key, isRequired] of needs) {
      if (available.get(key) === true || (!isRequired && available.has(key))) continue;
      if (consumed.has(key)) {
        if (isRequired) throw new TypeError(`${where} requires "${key}" after it was consumed`);
        continue;
      }
      external.set(key, isRequired);
      available.set(key, isRequired);
    }
  };
  for (const stage of stages) {
    need(stage.name, stage.requestNeeds);
    if (stage.through) {
      for (const key of stage.through.request.consumes) consumed.add(key);
      apply(available, stage.through.request);
    }
    if (stage.into) {
      if (stage.into.kind === 'named') {
        for (const declaration of stage.into.edges.values()) need(stage.name, declaration.request.needs);
      } else {
        need(stage.name, stage.into.edge.request.needs);
      }
    }
  }
  match(entry, external, `${name} entry`);
  return { available, consumed };
};

const deriveAssemblyExit = (
  assembly: Assembly,
  derived: ReadonlyMap<Assembly, Keys | undefined>,
  checkRequirements: boolean,
): Keys | undefined => {
  const { name, stages, targets } = assembly;
  const ending = stages.at(-1)!;
  const endingPaths: Keys[] = [];
  for (const [key, target] of targets) {
    const targetExit = derived.get(target.assembly);
    if (!targetExit) continue;
    if (checkRequirements) {
      requireGuaranteed(targetExit, target.declaration.response.needs, `${name} into "${key}" response`);
    }
    const after = new Map(targetExit);
    apply(after, target.declaration.response);
    endingPaths.push(after);
  }
  if (ending.answer) endingPaths.push(ending.answer);

  let response: Keys | undefined = endingPaths.length > 0 ? join(endingPaths) : undefined;
  for (let index = stages.length - 2; index >= 0; index -= 1) {
    const stage = stages[index]!;
    const paths: Keys[] = [];
    if (stage.through && response) {
      const { response: declaration } = stage.through;
      if (checkRequirements) requireGuaranteed(response, declaration.needs, `${stage.name} child response`);
      const after = new Map(response);
      apply(after, declaration);
      paths.push(after);
    }
    if (stage.answer) paths.push(stage.answer);
    response = paths.length > 0 ? join(paths) : undefined;
  }
  return response;
};

const validateSingleResponse = (assembly: Assembly): void => {
  const derived = new Map<Assembly, Keys | undefined>();
  const finalExit = deriveAssemblyExit(assembly, derived, true);
  if (!finalExit) throw new TypeError(`Pipeline "${assembly.name}" has no terminating response path`);
  match(assembly.exit, finalExit, `${assembly.name} exit`);
};

const validateReachableResponses = (pending: ReadonlyMap<Definition, Assembly>): void => {
  const derived = new Map<Assembly, Keys | undefined>();
  for (const assembly of pending.values()) derived.set(assembly, undefined);
  for (const assembly of pending.values()) {
    for (const target of assembly.targets.values()) {
      if (!derived.has(target.assembly)) derived.set(target.assembly, target.assembly.exit);
    }
  }

  let changed = true;
  while (changed) {
    changed = false;
    for (const assembly of pending.values()) {
      const next = deriveAssemblyExit(assembly, derived, false);
      if (!keysEqual(derived.get(assembly), next)) {
        derived.set(assembly, next);
        changed = true;
      }
    }
  }

  for (const assembly of pending.values()) {
    const finalExit = deriveAssemblyExit(assembly, derived, true);
    if (!finalExit) throw new TypeError(`Pipeline "${assembly.name}" has no terminating response path`);
    match(assembly.exit, finalExit, `${assembly.name} exit`);
  }
};

const parseTargets = (targets: Targets<never> | undefined, where: string): ReadonlyMap<string, TargetSource<never>> => {
  if (targets === undefined) return new Map();
  if (typeof targets !== 'object' || targets === null || Array.isArray(targets)) {
    throw new TypeError(`${where} targets must be a plain record`);
  }
  if (Object.getOwnPropertySymbols(targets).length > 0) {
    throw new TypeError(`${where} targets must not contain symbol keys`);
  }
  const map = new Map<string, TargetSource<never>>();
  for (const key of Object.getOwnPropertyNames(targets)) {
    const descriptor = Object.getOwnPropertyDescriptor(targets, key);
    if (!descriptor || !('value' in descriptor)) {
      throw new TypeError(`${where} targets must not contain accessor property "${key}"`);
    }
    const source: unknown = descriptor.value;
    if ((typeof source !== 'object' || source === null) && typeof source !== 'function') {
      throw new TypeError(`${where} target "${key}" must be a pipeline or target thunk`);
    }
    map.set(key, source as TargetSource<never>);
  }
  return map;
};

interface ComposeOptions {
  readonly entry: KeyMap;
  readonly exit: KeyMap;
  readonly stages: readonly Stage<never>[];
  readonly ending: Stage<never>;
  readonly targets?: Targets<never>;
}

export const composeFor = <Rq, Rs, S>(): Compose<Rq, Rs, S> => ((name: string, options: ComposeOptions) => {
  if (typeof name !== 'string' || !name) throw new TypeError('Pipeline name must be a non-empty string');
  const stages = options.stages.map(definitionOf);
  for (const stage of stages) {
    if (!stage.through) throw new TypeError(`Stage "${stage.name}" requires through before ending`);
  }
  const ending = definitionOf(options.ending);
  if (ending.through) throw new TypeError(`Ending "${ending.name}" declares through`);
  stages.push(ending);

  const entry = parseKeyMap(options.entry, `${name} entry`);
  const exit = parseKeyMap(options.exit, `${name} exit`);
  const supplied = parseTargets(options.targets, name);

  if (ending.into) {
    if (ending.into.kind === 'named') {
      for (const key of supplied.keys()) {
        if (!ending.into.edges.has(key)) throw new TypeError(`Ending "${ending.name}" has an undeclared target "${key}"`);
      }
      for (const key of ending.into.edges.keys()) {
        if (!supplied.has(key)) throw new TypeError(`Ending "${ending.name}" has no target "${key}"`);
      }
    } else if (supplied.size === 0 && stages.every(stage => !stage.answer)) {
      throw new TypeError(`Ending "${ending.name}" requires at least one target or an in-place return`);
    }
  } else if (supplied.size > 0) {
    throw new TypeError(`Ending "${ending.name}" does not declare into targets`);
  }

  const { available, consumed } = validateRequest(name, entry, stages);
  if (!ending.into) validateSingleResponse({ name, entry, exit, stages, targets: new Map() });

  const pipeline = Object.freeze({ name }) as Pipeline<never, never, S>;
  definitions.set(pipeline, { name, entry, exit, stages, supplied, available, consumed });
  return pipeline;
}) as unknown as Compose<Rq, Rs, S>;

export const asEntry = <I, O, S>(pipeline: Pipeline<I, O, S>): Entry<I, O, S> => {
  const pending = new Map<Definition, Assembly>();
  const visit = (target: PipelineReference<never>): Assembly => {
    const definition = isObject(target) ? definitions.get(target) : undefined;
    if (!definition) throw new TypeError(`Expected a composed pipeline${pipelineLabel(target)}`);
    const resolved = assemblies.get(definition) ?? pending.get(definition);
    if (resolved) return resolved;

    const { name, entry, exit, stages, supplied, available, consumed } = definition;
    const targets = new Map<string, Target>();
    const assembly: Assembly = { name, entry, exit, stages, targets };
    pending.set(definition, assembly);

    const ending = stages.at(-1)!;
    if (ending.into) {
      for (const [key, source] of supplied) {
        const declaration = ending.into.kind === 'named' ? ending.into.edges.get(key)! : ending.into.edge;
        const resolvedTarget = typeof source === 'function' ? source() : source;
        const linked = visit(resolvedTarget);
        const after = new Map(available);
        apply(after, declaration.request);
        const request = `${name} into "${key}" request`;
        requireGuaranteed(after, linked.entry, request);
        for (const [fact, isRequired] of linked.entry) {
          const provablyAbsent = !after.has(fact) && (consumed.has(fact) || declaration.request.consumes.has(fact));
          if (!isRequired && !after.has(fact) && !provablyAbsent) {
            throw new TypeError(`${request} does not provide or declare optional target key "${fact}"`);
          }
        }
        targets.set(key, { assembly: linked, declaration });
      }
    }
    return assembly;
  };
  const assembly = visit(pipeline);
  validateReachableResponses(pending);
  for (const [definition, linked] of pending) assemblies.set(definition, linked);
  entries.set(pipeline, assembly);
  return pipeline as Entry<I, O, S>;
};
