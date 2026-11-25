import { parseKeys } from './declarations.ts';
import type { FactKey, FactShape, KeyList, Keys, ParsedSide, ParsedThrough } from './declarations.ts';
import { definitionOf } from './stage.ts';
import type { Stage, StageDefinition } from './stage.ts';

declare const pipelineTypes: unique symbol;

export interface Pipeline<in I, out O, in S = {}> {
  readonly name: string;
  readonly [pipelineTypes]: (input: I, services: S) => O;
}

export type AnyPipeline = Pipeline<never, unknown, never>;
type TargetPipeline<S> = Pipeline<never, unknown, S>;

interface ComposeOptions<K extends string, S, T> {
  readonly entry: KeyList<K>;
  readonly exit: KeyList<K>;
  readonly stages: readonly Stage<S>[];
  readonly ending: Stage<S>;
  readonly targets?: Readonly<Record<string, T>>;
}

interface Target {
  readonly assembly: Assembly;
  readonly declaration: ParsedThrough;
}

export interface Assembly {
  readonly entry: Keys;
  readonly exit: Keys;
  readonly stages: readonly StageDefinition[];
  readonly targets: ReadonlyMap<string, Target>;
}

interface PreparedAssembly<T> {
  readonly handle: AnyPipeline;
  readonly assembly: Assembly & { readonly targets: Map<string, Target> };
  readonly supplied: Readonly<Record<string, T>>;
}

const assemblies = new WeakMap<AnyPipeline, Assembly>();

export const assemblyOf = (pipeline: AnyPipeline): Assembly => {
  const assembly = assemblies.get(pipeline);
  if (!assembly) throw new TypeError(`Expected a composed pipeline "${pipeline.name}"`);
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

const prepare = <T>(name: string, options: ComposeOptions<string, never, T>): PreparedAssembly<T> => {
  const stages = options.stages.map(definitionOf);
  for (const stage of stages) {
    if (stage.into) throw new TypeError(`Stage "${stage.name}" declares into outside ending`);
    if (!stage.through) throw new TypeError(`Stage "${stage.name}" has no continuation before ending`);
  }
  const ending = definitionOf(options.ending);
  if (ending.through) throw new TypeError(`Ending "${ending.name}" declares through`);
  stages.push(ending);

  const handle = Object.freeze({ name }) as AnyPipeline;
  return {
    handle,
    assembly: {
      entry: parseKeys(options.entry, `${name} entry`),
      exit: parseKeys(options.exit, `${name} exit`),
      stages,
      targets: new Map(),
    },
    supplied: options.targets ?? {},
  };
};

const validate = <T>(prepared: PreparedAssembly<T>, resolve: (target: T) => Assembly): void => {
  const { handle: { name }, assembly: { entry, exit, stages, targets }, supplied } = prepared;
  const ending = stages.at(-1)!;
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
      for (const key of stage.through.request.consumes) consumed.add(key);
      apply(available, stage.through.request);
    }
  }

  for (const key of Object.keys(supplied)) {
    if (!ending.into?.has(key)) throw new TypeError(`Ending "${ending.name}" has an undeclared target "${key}"`);
  }
  for (const declaration of ending.into?.values() ?? []) need(ending.name, declaration.request.needs);
  for (const [key, declaration] of ending.into ?? []) {
    if (!Object.hasOwn(supplied, key)) throw new TypeError(`Ending "${ending.name}" has no target "${key}"`);
    const target = resolve(supplied[key]);
    const after = new Map(available);
    apply(after, declaration.request);
    requireGuaranteed(after, target.entry, `${name} into "${key}" request`);
    requireGuaranteed(target.exit, declaration.response.needs, `${name} into "${key}" response`);
    targets.set(key, { assembly: target, declaration });
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

export const composeFor = <Space, S>() => <
  const Entry extends KeyList<FactKey<Space>>,
  const Exit extends KeyList<FactKey<Space>>,
>(
  name: string,
  options: ComposeOptions<FactKey<Space>, S, TargetPipeline<S>> & { readonly entry: Entry; readonly exit: Exit },
): Pipeline<FactShape<Space, Entry[number]>, FactShape<Space, Exit[number]>, S> => {
  const prepared = prepare(name, options);
  validate(prepared, assemblyOf);
  assemblies.set(prepared.handle, prepared.assembly);
  return prepared.handle as Pipeline<FactShape<Space, Entry[number]>, FactShape<Space, Exit[number]>, S>;
};

type Members<Space, S> = Readonly<Record<string, ComposeOptions<FactKey<Space>, S, TargetPipeline<S> | string>>>;
type LocalTargets<S, Group> = {
  readonly [Name in keyof Group]: {
    readonly targets?: Readonly<Record<string, TargetPipeline<S> | NoInfer<keyof Group & string>>>;
  };
};
type GroupPipelines<Space, S, Group extends Members<Space, S>> = {
  readonly [Name in keyof Group]: Pipeline<
    FactShape<Space, Group[Name]['entry'][number]>,
    FactShape<Space, Group[Name]['exit'][number]>,
    S
  >;
};

export const composeGroupFor = <Space, S>() => <const Group extends Members<Space, S>>(
  members: Group & LocalTargets<S, Group>,
): GroupPipelines<Space, S, Group> => {
  const definitions: Members<Space, S> = members;
  const prepared = Object.entries(definitions).map(([name, options]) => prepare(name, options));
  const local = new Map(prepared.map(({ handle, assembly }) => [handle.name, assembly]));
  for (const member of prepared) {
    validate(member, target => {
      if (typeof target !== 'string') return assemblyOf(target);
      const assembly = local.get(target);
      if (!assembly) throw new TypeError(`Pipeline "${member.handle.name}" targets unknown group member "${target}"`);
      return assembly;
    });
  }
  const handles = Object.fromEntries(prepared.map(({ handle, assembly }) => {
    assemblies.set(handle, assembly);
    return [handle.name, handle];
  }));
  return Object.freeze(handles) as GroupPipelines<Space, S, Group>;
};
