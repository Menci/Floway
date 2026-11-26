import { parseKeys } from './declarations.ts';
import type { FactKey, FactShape, KeyList, Keys, ParsedSide, ParsedThrough, Unmarked } from './declarations.ts';
import { definitionOf } from './stage.ts';
import type { IntoUses, Stage, StageDefinition } from './stage.ts';

declare const pipelineType: unique symbol;
declare const entryType: unique symbol;

interface PipelineReference<in S> {
  readonly name: string;
  readonly [pipelineType]: { readonly services: (services: S) => void };
}

interface PipelineContract<in I, out O, in S, in out IK, in out OK> extends PipelineReference<S> {
  readonly [pipelineType]: PipelineReference<S>[typeof pipelineType] & {
    readonly invoke: (facts: I) => O;
    readonly keys: (input: IK, output: OK) => [IK, OK];
  };
}

export type Pipeline<I, O, S = object> = PipelineContract<I, O, S, keyof I, keyof O>;

export interface Entry<I, O, in S = object> extends Pipeline<I, O, S> {
  readonly [entryType]: true;
}

type TargetSource<S> = PipelineReference<S> | (() => PipelineReference<S>);
type Targets<S> = Readonly<Record<string, TargetSource<S>>>;

type Reads<Space, Used> = [keyof Used] extends [keyof Space]
  ? [Pick<Required<Space>, keyof Used & keyof Space>] extends [Used] ? true : false
  : false;
type Writes<Space, Used> = [keyof Used] extends [keyof Space]
  ? [Used] extends [Pick<Required<Space>, keyof Used & keyof Space>] ? true : false
  : false;

type CheckStage<Rq, Rs, T> = T extends Stage<never, infer Used>
  ? false extends Reads<Rq, Used['requestNeeds']> | Writes<Rq, Used['requestProvides']>
    | Reads<Rs, Used['responseNeeds']> | Writes<Rs, Used['responseProvides']> ? never : T
  : never;

type StageList<Rq, Rs, L extends readonly Stage<never>[]> = { [K in keyof L]: CheckStage<Rq, Rs, L[K]> };

type RequiredProperties<T> = { [K in keyof T]-?: object extends Pick<T, K> ? never : K }[keyof T];
type Satisfies<Have, Need, Shared extends keyof Have & keyof Need = keyof Have & keyof Need> =
  [Pick<Have, Shared>] extends [Pick<Need, RequiredProperties<Need> | Shared>] ? true : false;

type KnownKeys<K> = string extends K ? never : K;
type RequestProvides<T> = T extends Stage<never, infer U> ? keyof U['requestProvides'] : never;
type AfterRequest<T, K> = T extends Stage<never, infer U>
  ? Exclude<K, KnownKeys<U['requestConsumes']>> | RequestProvides<T>
  : K;
type TargetRequestKeys<L extends readonly unknown[], K> = L extends readonly [infer H, ...infer T]
  ? TargetRequestKeys<T, AfterRequest<H, K>>
  : K | RequestProvides<L[number]>;

type ResponseNeeds<T> = T extends Stage<never, infer U> ? keyof U['responseNeeds'] : never;
type BeforeResponse<T, K> = T extends Stage<never, infer U>
  ? Exclude<K, KnownKeys<U['responseReplaces']>> | ResponseNeeds<T>
  : K;

// Every returned value needed below a stage is either supplied there or checked further upstream.
type TargetResponseNeeds<L extends readonly unknown[], K> = L extends readonly [infer H, ...infer T]
  ? TargetResponseNeeds<T, BeforeResponse<H, K>>
  : K | ResponseNeeds<L[number]>;

type Resolved<T> = T extends () => infer P ? P : T;
type CheckInput<Rq, I, K> = [Exclude<keyof I, K>] extends [keyof Rq]
  ? Satisfies<Pick<Required<Rq>, Exclude<keyof I, K> & keyof Rq>, I>
  : false;
type CheckOutput<Rs, O, K, U extends IntoUses> = false extends
  Satisfies<O, U['needs']> | Writes<Rs, Pick<Required<O>, keyof O & Exclude<K, KnownKeys<U['replaces']>>>> ? false : true;
type EdgeRequestAbsence<A, U extends IntoUses> = KnownKeys<U['requestConsumes']> | Exclude<A, U['requestProvides']>;
type CheckTarget<Rq, Rs, A, K, T, U extends IntoUses> = Resolved<T> extends PipelineContract<infer I, infer O, never, infer _IK, infer _OK>
  ? false extends CheckInput<Rq, I, EdgeRequestAbsence<A, U>> | CheckOutput<Rs, O, K, U> ? never : T
  : never;

type TargetsUsed<E> = E extends Stage<never, infer Used> ? Used['into'] : never;
type CheckTargets<Rq, Rs, Absent, Need, E, T> = {
  [K in keyof T]: K extends keyof TargetsUsed<E> ? CheckTarget<Rq, Rs, Absent, Need, T[K], TargetsUsed<E>[K]> : never;
};

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

export const entryAssembly = (entry: PipelineReference<never> & { readonly [entryType]: true }): Assembly => {
  const assembly = entries.get(entry);
  if (!assembly) throw new TypeError(`Expected a checked entry for pipeline "${entry.name}"`);
  return assembly;
};

const apply = (available: Map<string, boolean>, declaration: ParsedSide): void => {
  for (const key of declaration.consumes) available.delete(key);
  for (const [key, required] of declaration.provides) {
    available.set(key, required || available.get(key) === true);
  }
};

const requireGuaranteed = (available: Keys, needs: Keys, where: string): void => {
  for (const [key, required] of needs) {
    if (required && available.get(key) !== true) throw new TypeError(`${where} does not guarantee "${key}"`);
  }
};

const join = (paths: readonly Keys[]): Map<string, boolean> => {
  const keys = new Set(paths.flatMap(path => [...path.keys()]));
  return new Map([...keys].map(key => [key, paths.every(path => path.get(key) === true)]));
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
    for (const [key, required] of needs) {
      const typedOptional = !required && available.has(key) && (external.has(key) || consumed.has(key));
      if (available.get(key) === true || typedOptional) continue;
      if (consumed.has(key)) {
        if (required) throw new TypeError(`${where} requires "${key}" after it was consumed`);
        continue;
      }
      external.set(key, required);
      available.set(key, required);
    }
  };
  for (const stage of stages) {
    need(stage.name, stage.requestNeeds);
    if (stage.through) {
      for (const key of stage.through.request.consumes) consumed.add(key);
      apply(available, stage.through.request);
    }
    if (stage.into) {
      for (const declaration of stage.into.values()) need(stage.name, declaration.request.needs);
    }
  }
  match(entry, external, `${name} entry`);
  return { available, consumed };
};

const validateResponse = (assembly: Assembly): void => {
  const { name, exit, stages, targets } = assembly;
  const ending = stages.at(-1)!;
  let response = new Map<string, boolean>();
  for (const stage of stages.toReversed()) {
    const paths: Keys[] = [];
    if (stage.through) {
      const { response: declaration } = stage.through;
      requireGuaranteed(response, declaration.needs, `${stage.name} child response`);
      apply(response, declaration);
      paths.push(response);
    }
    if (stage === ending) {
      for (const target of targets.values()) {
        const after = new Map(target.assembly.exit);
        apply(after, target.declaration.response);
        paths.push(after);
      }
    }
    if (stage.answer) paths.push(stage.answer);
    response = join(paths);
  }
  match(exit, response, `${name} exit`);
};

export const composeFor = <Rq, Rs, S>() => <
  const I extends KeyList<FactKey<Rq>>,
  const O extends KeyList<FactKey<Rs>>,
  const L extends readonly Stage<S>[],
  const E extends Stage<S>,
  const T extends Targets<S> = Record<never, never>,
>(name: string, options: {
  readonly entry: I;
  readonly exit: O;
  readonly stages: L & StageList<Rq, Rs, NoInfer<L>>;
  readonly ending: E & CheckStage<Rq, Rs, NoInfer<E>>;
  readonly targets?: T & CheckTargets<
    Rq,
    Rs,
    Exclude<keyof Rq, TargetRequestKeys<NoInfer<L>, keyof Rq>>,
    TargetResponseNeeds<NoInfer<L>, Unmarked<NoInfer<O[number]>>>,
    NoInfer<E>,
    NoInfer<T>
  >;
}): Pipeline<FactShape<Rq, I[number]>, FactShape<Rs, O[number]>, S> => {
  const stages = options.stages.map(definitionOf);
  for (const stage of stages) {
    if (!stage.through) throw new TypeError(`Stage "${stage.name}" requires through before ending`);
  }
  const ending = definitionOf(options.ending);
  if (ending.through) throw new TypeError(`Ending "${ending.name}" declares through`);
  stages.push(ending);

  const entry = parseKeys(options.entry, `${name} entry`);
  const exit = parseKeys(options.exit, `${name} exit`);
  const supplied = new Map(Object.entries(options.targets ?? {}));
  for (const key of supplied.keys()) {
    if (!ending.into?.has(key)) throw new TypeError(`Ending "${ending.name}" has an undeclared target "${key}"`);
  }
  for (const key of ending.into?.keys() ?? []) {
    if (!supplied.has(key)) throw new TypeError(`Ending "${ending.name}" has no target "${key}"`);
  }
  const { available, consumed } = validateRequest(name, entry, stages);
  if (!ending.into) validateResponse({ name, entry, exit, stages, targets: new Map() });

  const pipeline = Object.freeze({ name }) as Pipeline<FactShape<Rq, I[number]>, FactShape<Rs, O[number]>, S>;
  definitions.set(pipeline, { name, entry, exit, stages, supplied, available, consumed });
  return pipeline;
};

export const asEntry = <I, O, S>(pipeline: Pipeline<I, O, S>): Entry<I, O, S> => {
  const pending = new Map<Definition, Assembly>();
  const visit = (target: PipelineReference<never>): Assembly => {
    const definition = definitions.get(target);
    if (!definition) throw new TypeError(`Expected a composed pipeline "${target.name}"`);
    const resolved = assemblies.get(definition) ?? pending.get(definition);
    if (resolved) return resolved;

    const { name, entry, exit, stages, supplied, available, consumed } = definition;
    const targets = new Map<string, Target>();
    const assembly = { name, entry, exit, stages, targets };
    pending.set(definition, assembly);
    for (const [key, declaration] of stages.at(-1)!.into ?? []) {
      const source = supplied.get(key)!;
      const linked = visit(typeof source === 'function' ? source() : source);
      const after = new Map(available);
      apply(after, declaration.request);
      const request = `${name} into "${key}" request`;
      requireGuaranteed(after, linked.entry, request);
      for (const [fact, required] of linked.entry) {
        if (!required && after.get(fact) !== true && !entry.has(fact) && !consumed.has(fact) && !declaration.request.consumes.has(fact)) {
          throw new TypeError(`${request} does not declare a typed source for optional target key "${fact}"`);
        }
      }
      requireGuaranteed(linked.exit, declaration.response.needs, `${name} into "${key}" response`);
      targets.set(key, { assembly: linked, declaration });
    }
    validateResponse(assembly);
    return assembly;
  };
  const assembly = visit(pipeline);
  for (const [definition, linked] of pending) assemblies.set(definition, linked);
  entries.set(pipeline, assembly);
  return pipeline as Entry<I, O, S>;
};
