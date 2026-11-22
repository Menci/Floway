import { DeclarationViolationError } from './errors.ts';
import type { ChildOptions, Ending, Next, Stage, ThroughDecl } from './stage.ts';

declare const pipelineTypes: unique symbol;

export interface Pipeline<in I, out O, in S = {}> {
  readonly name: string;
  readonly entry: readonly string[];
  readonly exit: readonly string[];
  readonly [pipelineTypes]?: (facts: I, services: S) => O;
}

export type StaticTarget<I, O, S> = Pipeline<I, O, S> | (() => Pipeline<I, O, S>);

export interface DynamicTarget<K, I, O, S> {
  readonly entry: readonly string[];
  readonly exit: readonly string[];
  readonly resolve: (key: K, services: Readonly<S>) => Pipeline<I, O, S>;
}

export type TargetMap = Readonly<Record<string, StaticTarget<any, any, any> | DynamicTarget<any, any, any, any>>>;

export type IntoMap<T> = {
  readonly [K in keyof T]:
  T[K] extends DynamicTarget<infer Key, infer I, infer O, any> ? <Actual extends I>(key: Key, facts: Actual, options?: ChildOptions) => Promise<O>
    : T[K] extends StaticTarget<infer I, infer O, any> ? Next<I, O>
      : never;
};

type AnyPipeline = Pipeline<any, any, any>;
type DynamicSlot = DynamicTarget<any, any, any, any>;

interface StaticSlot {
  readonly target: StaticTarget<any, any, any>;
  resolved?: AnyPipeline;
}

export type Slot = StaticSlot | DynamicSlot;

interface Assembly {
  readonly stages: readonly Stage<any>[];
  readonly ending: Ending<any, any>;
  readonly targets: Readonly<Record<string, Slot>>;
  linked: boolean;
}

const assemblies = new WeakMap<AnyPipeline, Assembly>();

export const assemblyOf = (pipeline: AnyPipeline): Assembly => {
  const assembly = assemblies.get(pipeline);
  if (!assembly) throw new TypeError(`Expected a composed pipeline: ${pipeline.name}`);
  return assembly;
};

type TargetOptions<T extends TargetMap> = keyof T extends never ? { readonly targets?: never }
  : { readonly targets: T };

export const compose = <In, Out, S, Targets extends TargetMap = {}>(name: string, options: {
  readonly stages: readonly Stage<S>[];
  readonly ending: Ending<Targets, S>;
} & TargetOptions<Targets>): Pipeline<In, Out, S> => {
  const { stages, ending } = options;
  const names = new Set([ending.name]);
  if (ending.kind !== 'ending') throw new TypeError(`Pipeline "${name}" must finish with an ending`);

  const entry = new Set<string>();
  const provided = new Set<string>();
  const consumed = new Set<string>();
  const requireKeys = (stage: string, needs: readonly string[]): void => {
    for (const key of needs) {
      if (provided.has(key)) continue;
      if (consumed.has(key)) throw new DeclarationViolationError(stage, 'entry', `"${key}" was consumed by an earlier stage`);
      entry.add(key);
    }
  };

  for (const stage of stages) {
    if (stage.kind !== 'stage' || 'targets' in stage) throw new TypeError(`Only the ending of "${name}" can define targets`);
    if (names.has(stage.name)) throw new TypeError(`Duplicate stage "${stage.name}" in pipeline "${name}"`);
    names.add(stage.name);
    if (!stage.through) continue;
    const request = stage.through.request;
    requireKeys(stage.name, request.needs);
    for (const key of request.consumes) {
      consumed.add(key);
      provided.delete(key);
    }
    for (const key of request.provides) provided.add(key);
  }
  requireKeys(ending.name, ending.request.needs);
  const declaredSlots: Readonly<Record<string, ThroughDecl>> = ending.into ?? {};
  const suppliedSlots: TargetMap = options.targets ?? {};
  for (const [key, declaration] of Object.entries(declaredSlots)) {
    if (!Object.hasOwn(suppliedSlots, key)) throw new TypeError(`Ending "${ending.name}" declares a missing target "${key}"`);
    requireKeys(ending.name, declaration.request.needs);
  }
  for (const key of Object.keys(suppliedSlots)) {
    if (!Object.hasOwn(declaredSlots, key)) throw new TypeError(`Ending "${ending.name}" has an undeclared target "${key}"`);
  }

  const exits = Object.values(declaredSlots).map(({ response }) => new Set([
    ...response.needs.filter(key => !response.consumes.includes(key)), ...response.provides,
  ]));
  if (ending.return) exits.push(new Set(ending.return.provides));
  if (exits.length === 0) throw new TypeError(`Ending "${ending.name}" has no response path`);
  const [first, ...others] = exits;
  const exit = new Set([...first].filter(key => others.every(path => path.has(key))));
  for (const stage of stages.toReversed()) {
    const response = stage.through?.response;
    if (response) {
      for (const key of response.needs) {
        if (!exit.has(key)) throw new DeclarationViolationError(stage.name, 'up', `no child guarantees "${key}"`);
      }
      for (const key of response.consumes) exit.delete(key);
      for (const key of response.provides) exit.add(key);
    }
    if (stage.return) {
      const synthetic = new Set(stage.return.provides);
      if (response) {
        for (const key of exit) {
          if (!synthetic.has(key)) exit.delete(key);
        }
      } else {
        exit.clear();
        for (const key of synthetic) exit.add(key);
      }
    }
  }

  const targets: Record<string, Slot> = Object.create(null);
  for (const [key, target] of Object.entries(suppliedSlots)) {
    targets[key] = typeof target !== 'function' && 'resolve' in target
      ? Object.freeze({ entry: Object.freeze([...target.entry]), exit: Object.freeze([...target.exit]), resolve: target.resolve })
      : { target };
  }
  const pipeline: Pipeline<In, Out, S> = Object.freeze({
    name, entry: Object.freeze([...entry]), exit: Object.freeze([...exit]),
  });
  assemblies.set(pipeline, { stages: Object.freeze([...stages]), ending, targets: Object.freeze(targets), linked: false });
  return pipeline;
};

const staticResolutions = new WeakMap<() => AnyPipeline, AnyPipeline>();

export const link = (pipelines: readonly AnyPipeline[]): void => {
  const seen = new Set<AnyPipeline>();
  const visit = (pipeline: AnyPipeline): void => {
    if (seen.has(pipeline)) return;
    const assembly = assemblyOf(pipeline);
    seen.add(pipeline);
    for (const [name, slot] of Object.entries(assembly.targets)) {
      if ('resolve' in slot) continue;
      if (!slot.resolved) {
        const { target } = slot;
        const resolved = typeof target === 'function' ? staticResolutions.get(target) ?? target() : target;
        assemblyOf(resolved);
        if (typeof target === 'function') staticResolutions.set(target, resolved);
        slot.resolved = resolved;
        Object.freeze(slot);
      }
      for (const key of assembly.ending.into![name].response.needs) {
        if (!slot.resolved.exit.includes(key)) {
          throw new DeclarationViolationError(assembly.ending.name, 'up', `target "${name}" does not guarantee "${key}"`);
        }
      }
      visit(slot.resolved);
    }
  };
  for (const pipeline of pipelines) visit(pipeline);
  for (const pipeline of seen) assemblyOf(pipeline).linked = true;
};

const validatedSlots = new WeakMap<DynamicSlot, Map<unknown, WeakSet<AnyPipeline>>>();

export const resolveSlot = (slot: Slot, key: unknown, services: any): AnyPipeline => {
  if ('target' in slot) {
    if (!slot.resolved) throw new Error('Unlinked static target');
    return slot.resolved;
  }
  const pipeline = slot.resolve(key, services);
  assemblyOf(pipeline);
  let keys = validatedSlots.get(slot);
  if (!keys) validatedSlots.set(slot, keys = new Map());
  let validated = keys.get(key);
  if (!validated) keys.set(key, validated = new WeakSet());
  if (!validated.has(pipeline)) {
    for (const name of pipeline.entry) {
      if (!slot.entry.includes(name)) throw new DeclarationViolationError(pipeline.name, 'entry', `dynamic target needs unregistered "${name}"`);
    }
    for (const name of slot.exit) {
      if (!pipeline.exit.includes(name)) throw new DeclarationViolationError(pipeline.name, 'up', `dynamic target does not guarantee "${name}"`);
    }
    validated.add(pipeline);
  }
  return pipeline;
};
