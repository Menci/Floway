import { DeclarationViolationError } from './errors.ts';
import type { Ending, Next, SideDecl, Stage, ThroughDecl } from './stage.ts';

declare const pipelineTypes: unique symbol;

export interface Pipeline<in I, out O, in S = {}> {
  readonly name: string;
  readonly entry: readonly string[];
  readonly exit: readonly string[];
  readonly [pipelineTypes]?: (facts: I, services: S) => O;
}

export type StaticTarget<I, O, S> = Pipeline<I, O, S> | (() => Pipeline<I, O, S>);
export type TargetMap<S = any> = Readonly<Record<string, StaticTarget<any, any, S>>>;

export type IntoMap<T> = {
  readonly [K in keyof T]: T[K] extends StaticTarget<infer I, infer O, any> ? Next<I, O> : never;
};

type AnyPipeline = Pipeline<any, any, any>;

interface Target {
  readonly name: string;
  readonly declaration: ThroughDecl;
  readonly target: StaticTarget<any, any, any>;
}

interface LinkedTarget {
  readonly name: string;
  readonly declaration: ThroughDecl;
  readonly pipeline: AnyPipeline;
}

interface Assembly {
  readonly stages: readonly Stage<any>[];
  readonly ending: Ending<any, any>;
  readonly targets: readonly Target[];
  linkedTargets?: readonly LinkedTarget[];
}

const assemblies = new WeakMap<AnyPipeline, Assembly>();

export const assemblyOf = (pipeline: AnyPipeline): Assembly => {
  const assembly = assemblies.get(pipeline);
  if (!assembly) throw new TypeError(`Expected a composed pipeline: ${pipeline.name}`);
  return assembly;
};

type RequiredKeys<T> = { [K in keyof T]-?: {} extends Pick<T, K> ? never : K }[keyof T] & string;

type TargetOptions<T extends TargetMap> = keyof T extends never ? { readonly targets?: never } : { readonly targets: T };

const uniqueKeys = (pipeline: string, direction: 'entry' | 'up', label: string, keys: readonly string[]): Set<string> => {
  const seen = new Set<string>();
  for (const key of keys) {
    if (seen.has(key)) throw new DeclarationViolationError(pipeline, direction, `duplicate "${key}" in ${label}`);
    seen.add(key);
  }
  return seen;
};

const applySide = (keys: Set<string>, side: SideDecl): void => {
  for (const key of side.consumes) keys.delete(key);
  for (const key of side.provides) keys.add(key);
};

const deriveExit = (stages: readonly Stage<any>[], ending: Ending<any, any>, slots: readonly Target[]): Set<string> => {
  const paths = slots.map(({ declaration: { response } }) => {
    const keys = new Set(response.needs);
    applySide(keys, response);
    return keys;
  });
  if (ending.return) paths.push(new Set(ending.return.provides));
  if (paths.length === 0) throw new TypeError(`Ending "${ending.name}" has no response path`);
  let guaranteed = new Set([...paths[0]].filter(key => paths.every(path => path.has(key))));
  for (const stage of stages.toReversed()) {
    const response = stage.through?.response;
    if (response) {
      for (const key of response.needs) {
        if (!guaranteed.has(key)) throw new DeclarationViolationError(stage.name, 'up', `no child guarantees "${key}"`);
      }
      applySide(guaranteed, response);
    }
    if (stage.return) {
      const provided = stage.return.provides;
      guaranteed = new Set(response ? provided.filter(key => guaranteed.has(key)) : provided);
    }
  }
  return guaranteed;
};

export const compose = <Space, S = {}>() => <
  const Entry extends readonly RequiredKeys<Space>[],
  const Exit extends readonly RequiredKeys<Space>[],
  const OptEntry extends readonly (keyof Space & string)[] = readonly [],
  Targets extends TargetMap<S> = {},
>(name: string, options: {
  readonly entry: Entry;
  readonly optionalEntry?: OptEntry;
  readonly exit: Exit;
  readonly stages: readonly Stage<S>[];
  readonly ending: Ending<Targets, S>;
} & TargetOptions<Targets>): Pipeline<
  { readonly [K in Entry[number]]: Space[K] } & { readonly [K in OptEntry[number]]?: Exclude<Space[K], undefined> },
  { readonly [K in Exit[number]]: Space[K] },
  S
> => {
  const { entry, optionalEntry = [], exit, stages, ending } = options;
  if (ending.kind !== 'ending') throw new TypeError(`Pipeline "${name}" must finish with an ending`);
  const names = new Set([ending.name]);
  const required = uniqueKeys(name, 'entry', 'entry', entry);
  for (const key of uniqueKeys(name, 'entry', 'optionalEntry', optionalEntry)) {
    if (required.has(key)) throw new DeclarationViolationError(name, 'entry', `"${key}" appears in both entry and optionalEntry`);
  }
  uniqueKeys(name, 'up', 'exit', exit);
  const available = new Set(required);
  const consumed = new Set<string>();
  const checkNeeds = (stage: string, needs: readonly string[]): void => {
    for (const key of needs) {
      if (available.has(key)) continue;
      const detail = consumed.has(key) ? `"${key}" was consumed by an earlier stage` : `entry does not guarantee "${key}"`;
      throw new DeclarationViolationError(stage, 'entry', detail);
    }
  };
  for (const stage of stages) {
    if (stage.kind !== 'stage' || 'targets' in stage) throw new TypeError(`Only the ending of "${name}" can define targets`);
    if (names.has(stage.name)) throw new TypeError(`Duplicate stage "${stage.name}" in pipeline "${name}"`);
    names.add(stage.name);
    if (!stage.through) continue;
    const { request } = stage.through;
    checkNeeds(stage.name, request.needs);
    for (const key of request.consumes) consumed.add(key);
    applySide(available, request);
  }
  checkNeeds(ending.name, ending.request.needs);

  const declarations: Readonly<Record<string, ThroughDecl>> = ending.into ?? {};
  const supplied: TargetMap = options.targets ?? {};
  for (const key of Object.keys(supplied)) {
    if (!Object.hasOwn(declarations, key)) throw new TypeError(`Ending "${ending.name}" has an undeclared target "${key}"`);
  }
  const targets = Object.entries(declarations).map(([name, declaration]) => {
    if (!Object.hasOwn(supplied, name)) throw new TypeError(`Ending "${ending.name}" declares a missing target "${name}"`);
    return Object.freeze({ name, declaration, target: supplied[name] });
  });
  const guaranteed = deriveExit(stages, ending, targets);
  for (const key of exit) {
    if (!guaranteed.has(key)) throw new DeclarationViolationError(name, 'up', `no response path guarantees "${key}" on every return`);
  }

  const pipeline = Object.freeze({ name, entry: Object.freeze([...entry]), exit: Object.freeze([...exit]) });
  assemblies.set(pipeline, { stages: Object.freeze([...stages]), ending, targets: Object.freeze(targets) });
  return pipeline;
};

const staticResolutions = new WeakMap<() => AnyPipeline, AnyPipeline>();

const resolve = (target: StaticTarget<any, any, any>): AnyPipeline => {
  if (typeof target !== 'function') return target;
  const previous = staticResolutions.get(target);
  if (previous !== undefined) return previous;
  const pipeline = target();
  assemblyOf(pipeline);
  staticResolutions.set(target, pipeline);
  return pipeline;
};

export const link = (pipelines: readonly AnyPipeline[]): void => {
  const seen = new Map<Assembly, readonly LinkedTarget[]>();
  const visit = (pipeline: AnyPipeline): void => {
    const assembly = assemblyOf(pipeline);
    if (assembly.linkedTargets || seen.has(assembly)) return;
    const atEnding = new Set(pipeline.entry);
    for (const stage of assembly.stages) {
      if (stage.through) applySide(atEnding, stage.through.request);
    }
    const targets = assembly.targets.map(({ name, declaration, target }) => {
      const linked = resolve(target);
      for (const key of declaration.response.needs) {
        if (!linked.exit.includes(key)) {
          throw new DeclarationViolationError(assembly.ending.name, 'up', `target "${name}" does not guarantee "${key}"`);
        }
      }
      const available = new Set(atEnding);
      applySide(available, declaration.request);
      for (const key of linked.entry) {
        if (!available.has(key)) {
          throw new DeclarationViolationError(assembly.ending.name, 'down', `target "${name}" requires "${key}"`);
        }
      }
      return Object.freeze({ name, declaration, pipeline: linked });
    });
    seen.set(assembly, Object.freeze(targets));
    for (const target of targets) visit(target.pipeline);
  };
  for (const pipeline of pipelines) visit(pipeline);
  for (const [assembly, targets] of seen) assembly.linkedTargets = targets;
};
