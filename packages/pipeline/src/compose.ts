import { parseKeys } from './declarations.ts';
import type { KeyList, Keys, ParsedSide, ParsedThrough } from './declarations.ts';
import { defineStageFor, definitionOf } from './stage.ts';
import type { FactKey, FactShape, Stage, StageDefinition } from './stage.ts';

declare const pipelineTypes: unique symbol;

export interface Pipeline<in I, out O, in S = {}> {
  readonly name: string;
  readonly entry: KeyList;
  readonly exit: KeyList;
  readonly [pipelineTypes]: (input: I, services: S) => O;
}

type AnyPipeline = Pipeline<never, unknown, never>;
type Targets<S> = Readonly<Record<string, Pipeline<never, unknown, S> | (() => Pipeline<never, unknown, S>)>>;

interface Target {
  readonly declaration: ParsedThrough;
  readonly resolve: AnyPipeline | (() => AnyPipeline);
  readonly available: Keys;
}

export interface Assembly {
  readonly entry: Keys;
  readonly exit: Keys;
  readonly stages: readonly StageDefinition[];
  readonly targets: ReadonlyMap<string, Target>;
  linked?: ReadonlyMap<string, AnyPipeline>;
}

const assemblies = new WeakMap<AnyPipeline, Assembly>();

export const assemblyOf = (pipeline: AnyPipeline): Assembly => {
  const assembly = assemblies.get(pipeline);
  if (!assembly) throw new TypeError(`Expected a composed pipeline "${pipeline.name}"`);
  return assembly;
};

const apply = (available: Map<string, boolean>, declaration: ParsedSide): void => {
  for (const key of declaration.consumes.keys()) available.delete(key);
  for (const [key, required] of declaration.provides) {
    available.set(key, required || available.get(key) === true);
  }
};

const requireGuaranteed = (available: Keys, needs: Keys, where: string): void => {
  for (const [key, required] of needs) {
    if (required && available.get(key) !== true) throw new TypeError(`${where} does not guarantee "${key}"`);
  }
};

const checkTarget = (name: string, key: string, target: Target, pipeline: AnyPipeline): void => {
  const { entry, exit } = assemblyOf(pipeline);
  requireGuaranteed(target.available, entry, `${name} into "${key}" request`);
  requireGuaranteed(exit, target.declaration.response.needs, `${name} into "${key}" response`);
};

const join = (paths: readonly Keys[]): Map<string, boolean> => {
  const result = new Map<string, boolean>();
  const keys = new Set(paths.flatMap(path => [...path.keys()]));
  for (const key of keys) result.set(key, paths.every(path => path.get(key) === true));
  return result;
};

const match = (declared: Keys, derived: Keys, where: string): void => {
  for (const key of new Set([...declared.keys(), ...derived.keys()])) {
    if (declared.get(key) !== derived.get(key)) throw new TypeError(`${where} disagrees with the stages on "${key}"`);
  }
};

const composeFor = <Space, S>() => <
  const Entry extends KeyList<FactKey<Space>>,
  const Exit extends KeyList<FactKey<Space>>,
>(name: string, options: {
  readonly entry: Entry;
  readonly exit: Exit;
  readonly stages: readonly Stage<S>[];
  readonly ending: Stage<S>;
  readonly targets?: Targets<S>;
}): Pipeline<FactShape<Space, Entry[number]>, FactShape<Space, Exit[number]>, S> => {
  const stages = [...options.stages, options.ending].map(definitionOf);
  for (const stage of stages.slice(0, -1)) {
    if (stage.into) throw new TypeError(`Stage "${stage.name}" declares into outside ending`);
    if (!stage.through) throw new TypeError(`Stage "${stage.name}" has no continuation before ending`);
  }
  const ending = stages.at(-1)!;
  if (ending.through) throw new TypeError(`Ending "${ending.name}" declares through`);

  const entry = parseKeys(options.entry, `${name} entry`);
  const exit = parseKeys(options.exit, `${name} exit`);
  const external = new Map<string, boolean>();
  const available = new Map<string, boolean>();
  const consumed = new Set<string>();
  const need = (where: string, needs: Keys): void => {
    for (const [key, required] of needs) {
      if (available.get(key) === true || (!required && available.has(key))) continue;
      if (consumed.has(key)) {
        if (required) throw new TypeError(`${where} requires "${key}" after it was consumed`);
        continue;
      }
      external.set(key, required || external.get(key) === true);
      available.set(key, required);
    }
  };
  for (const stage of stages) {
    need(stage.name, stage.requestNeeds);
    if (stage.through) {
      for (const key of stage.through.request.consumes.keys()) consumed.add(key);
      apply(available, stage.through.request);
    }
  }

  const targets = new Map<string, Target>();
  const supplied = options.targets ?? {};
  const into = ending.into ?? new Map<string, ParsedThrough>();
  for (const key of Object.keys(supplied)) {
    if (!into.has(key)) throw new TypeError(`Ending "${ending.name}" has an undeclared target "${key}"`);
  }
  for (const declaration of into.values()) need(ending.name, declaration.request.needs);
  for (const [key, declaration] of into) {
    if (!Object.hasOwn(supplied, key)) throw new TypeError(`Ending "${ending.name}" has no target "${key}"`);
    const after = new Map(available);
    apply(after, declaration.request);
    const target = { declaration, resolve: supplied[key], available: after };
    if (typeof target.resolve !== 'function') checkTarget(name, key, target, target.resolve);
    targets.set(key, target);
  }
  match(entry, external, `${name} entry`);

  let response = new Map<string, boolean>();
  for (const stage of stages.toReversed()) {
    const paths: Keys[] = [];
    if (stage.through) {
      const { response: declaration } = stage.through;
      requireGuaranteed(response, declaration.needs, `${stage.name} child response`);
      apply(response, declaration);
      paths.push(response);
    }
    for (const declaration of stage.into?.values() ?? []) {
      const provided = new Map(declaration.response.needs);
      apply(provided, declaration.response);
      paths.push(provided);
    }
    if (stage.answer) paths.push(stage.answer);
    response = join(paths);
  }
  match(exit, response, `${name} exit`);

  const pipeline = Object.freeze({
    name,
    entry: Object.freeze([...options.entry]),
    exit: Object.freeze([...options.exit]),
  }) as Pipeline<FactShape<Space, Entry[number]>, FactShape<Space, Exit[number]>, S>;
  assemblies.set(pipeline, { entry, exit, stages, targets });
  return pipeline;
};

export const linkTargets = (pipeline: AnyPipeline): void => {
  const links = new Map<Assembly, Map<string, AnyPipeline>>();
  const visit = (handle: AnyPipeline): void => {
    const assembly = assemblyOf(handle);
    if (assembly.linked || links.has(assembly)) return;
    const linked = new Map<string, AnyPipeline>();
    links.set(assembly, linked);
    for (const [key, target] of assembly.targets) {
      const pipeline = typeof target.resolve === 'function' ? target.resolve() : target.resolve;
      checkTarget(handle.name, key, target, pipeline);
      linked.set(key, pipeline);
      visit(pipeline);
    }
  };
  visit(pipeline);
  for (const [assembly, linked] of links) assembly.linked = linked;
};

export const factSpace = <Space, Services = {}>() => Object.freeze({
  defineStage: defineStageFor<Space, Services>(),
  compose: composeFor<Space, Services>(),
});
