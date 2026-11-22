import { DISPATCH_BRAND } from './types.ts';
import type {
  BoundDispatch,
  Ending,
  Facts,
  Pipeline,
  RequestStage,
  Stage,
  TapPoint,
} from './types.ts';

type EmptyServices = Record<never, never>;

interface StageOptions {
  readonly tap?: TapPoint;
}

interface EndingOptions {
  readonly tap?: TapPoint;
}

interface TerminalOptions<Needs extends object> extends EndingOptions {
  readonly prepare?: (facts: Readonly<Needs>) => Needs;
}

export interface StageDefinition<
  Needs extends object,
  Provided extends object,
  InnerOut,
  Out,
  Consumed extends keyof Needs & string,
  Services extends object,
> extends StageOptions {
  readonly name: string;
  readonly consumes?: readonly Consumed[];
  readonly provides?: readonly (keyof Provided & string)[];
  readonly execute: (
    facts: Readonly<Needs>,
    next: import('./types.ts').NextFn<Provided, InnerOut>,
    env: import('./types.ts').StageEnv<Services>,
  ) => Promise<Out>;
}

export interface RequestStageDefinition<
  Needs extends object,
  Provided extends object,
  Consumed extends keyof Needs & string,
  Services extends object,
> extends StageOptions {
  readonly name: string;
  readonly consumes?: readonly Consumed[];
  readonly provides?: readonly (keyof Provided & string)[];
  readonly execute: <Out>(
    facts: Readonly<Needs>,
    next: import('./types.ts').NextFn<Provided, Out>,
    env: import('./types.ts').StageEnv<Services>,
  ) => Promise<Out>;
}

export const defineStage = <
  Needs extends object = EmptyServices,
  Provided extends object = EmptyServices,
  InnerOut = unknown,
  Out = InnerOut,
  Consumed extends keyof Needs & string = never,
  Services extends object = EmptyServices,
>(definition: StageDefinition<Needs, Provided, InnerOut, Out, Consumed, Services>): Stage<
  Needs,
  Provided,
  InnerOut,
  Out,
  Consumed,
  Services
> => Object.freeze({
  kind: 'stage',
  name: definition.name,
  ...(definition.tap === undefined ? {} : { tap: definition.tap }),
  ...(definition.consumes === undefined ? {} : { consumes: Object.freeze([...definition.consumes]) }),
  ...(definition.provides === undefined ? {} : { provides: Object.freeze([...definition.provides]) }),
  execute: definition.execute,
});

export const defineRequestStage = <
  Needs extends object = EmptyServices,
  Provided extends object = EmptyServices,
  Consumed extends keyof Needs & string = never,
  Services extends object = EmptyServices,
>(definition: RequestStageDefinition<Needs, Provided, Consumed, Services>): RequestStage<
  Needs,
  Provided,
  Consumed,
  Services
> => Object.freeze({
  kind: 'request-stage',
  name: definition.name,
  ...(definition.tap === undefined ? {} : { tap: definition.tap }),
  ...(definition.consumes === undefined ? {} : { consumes: Object.freeze([...definition.consumes]) }),
  ...(definition.provides === undefined ? {} : { provides: Object.freeze([...definition.provides]) }),
  execute: definition.execute as RequestStage<Needs, Provided, Consumed, Services>['execute'],
});

export function terminal<
  Needs extends object = EmptyServices,
  Out = unknown,
  Services extends object = EmptyServices,
>(definition: {
  readonly name: string;
  readonly tap?: TapPoint;
  readonly prepare?: (facts: Readonly<Needs>) => Needs;
  readonly execute: (facts: Readonly<Needs>, env: import('./types.ts').StageEnv<Services>) => Promise<Out>;
}): Ending<Needs, Out, Services>;
export function terminal<
  Needs extends object = EmptyServices,
  Out = unknown,
  Services extends object = EmptyServices,
>(
  name: string,
  execute: (facts: Readonly<Needs>, env: import('./types.ts').StageEnv<Services>) => Promise<Out>,
  options?: TerminalOptions<Needs>,
): Ending<Needs, Out, Services>;
export function terminal<
  Needs extends object,
  Out,
  Services extends object,
>(
  nameOrDefinition: string | {
    readonly name: string;
    readonly tap?: TapPoint;
    readonly prepare?: (facts: Readonly<Needs>) => Needs;
    readonly execute: (facts: Readonly<Needs>, env: import('./types.ts').StageEnv<Services>) => Promise<Out>;
  },
  execute?: (facts: Readonly<Needs>, env: import('./types.ts').StageEnv<Services>) => Promise<Out>,
  options?: TerminalOptions<Needs>,
): Ending<Needs, Out, Services> {
  const definition = typeof nameOrDefinition === 'string'
    ? { name: nameOrDefinition, execute: execute!, ...options }
    : nameOrDefinition;
  return Object.freeze({
    kind: 'terminal',
    name: definition.name,
    ...(definition.tap === undefined ? {} : { tap: definition.tap }),
    ...('prepare' in definition && definition.prepare !== undefined ? { prepare: definition.prepare } : {}),
    execute: definition.execute,
  });
}

export function dispatch<
  Needs extends object = EmptyServices,
  Out = unknown,
  Services extends object = EmptyServices,
>(definition: {
  readonly name: string;
  readonly tap?: TapPoint;
  readonly select: (
    facts: Readonly<Needs>,
    env: import('./types.ts').StageEnv<Services>,
  ) => BoundDispatch<Out, Services> | Promise<BoundDispatch<Out, Services>>;
}): Ending<Needs, Out, Services>;
export function dispatch<
  Needs extends object = EmptyServices,
  Out = unknown,
  Services extends object = EmptyServices,
>(
  name: string,
  select: (
    facts: Readonly<Needs>,
    env: import('./types.ts').StageEnv<Services>,
  ) => BoundDispatch<Out, Services> | Promise<BoundDispatch<Out, Services>>,
  options?: EndingOptions,
): Ending<Needs, Out, Services>;
export function dispatch<
  Needs extends object,
  Out,
  Services extends object,
>(
  nameOrDefinition: string | {
    readonly name: string;
    readonly tap?: TapPoint;
    readonly select: (
      facts: Readonly<Needs>,
      env: import('./types.ts').StageEnv<Services>,
    ) => BoundDispatch<Out, Services> | Promise<BoundDispatch<Out, Services>>;
  },
  select?: (
    facts: Readonly<Needs>,
    env: import('./types.ts').StageEnv<Services>,
  ) => BoundDispatch<Out, Services> | Promise<BoundDispatch<Out, Services>>,
  options?: EndingOptions,
): Ending<Needs, Out, Services> {
  const definition = typeof nameOrDefinition === 'string'
    ? { name: nameOrDefinition, select: select!, ...options }
    : nameOrDefinition;
  return Object.freeze({
    kind: 'dispatch',
    name: definition.name,
    ...(definition.tap === undefined ? {} : { tap: definition.tap }),
    select: definition.select,
  });
}

export const handoff = <TargetIn extends object, Out, Services extends object>(
  target: Pipeline<TargetIn, Out, Services>,
  input: TargetIn,
): BoundDispatch<Out, Services> => Object.freeze({
  [DISPATCH_BRAND]: true as const,
  target,
  input: input as Facts,
});
